## 1. 技術選定(この構成で実装すること)

| レイヤ                    | 採用                                      | 採用理由(レポートにも書く)                                                                                                                                                                                                                                                     |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| IaC                       | AWS CDK v2 (TypeScript)                   | マルチリージョン構成(us-east-1 の WAF)をコードで表現でき、`cdk synth` の差分がレポートの証跡になる                                                                                                                                                                             |
| IaC 検査                  | cdk-nag v3 (AwsSolutions ルールパック)    | 「静的に検査した」という事実自体がアピール材料。v3 は CDK ネイティブの Policy Validation プラグインとして動き、結果は `cdk.out/validation-report.json` に出る。抑制は理由必須で `Validations.of(scope).acknowledge({ id, reason })` に記述する(v2 の `NagSuppressions` は廃止) |
| ツールチェーン            | Vite+ (`vp`)                              | ランタイム管理・パッケージ管理・フロントエンドツールを単一の CLI (`vp`) に統合(Vite / Rolldown / Vitest / tsdown / Oxlint / Oxfmt を内包)。`vp dev` / `vp build` で Vite を起動し、`vp check`(フォーマット/lint/型チェック)と `vp test` を検証コマンドとして統一する           |
| フロント                  | React 18 + TypeScript(Vite+ 経由でビルド) | 本番ビルドが外部 module script 中心で、`script-src 'self'` を成立させやすい                                                                                                                                                                                                    |
| スタイル                  | Tailwind CSS                              | **CSS-in-JS(Emotion / styled-components / MUI)は禁止**。実行時に inline `<style>` を注入するため `style-src 'unsafe-inline'` が必要になり、CSP 実験の主旨を損なう                                                                                                              |
| 認証                      | `react-oidc-context` + `oidc-client-ts`   | Cognito Managed Login (Authorization Code + PKCE) の標準的な組み合わせ                                                                                                                                                                                                         |
| ルーティング              | react-router-dom                          | SPA ルーティングと CloudFront 側の rewrite の相互作用を検証対象にする                                                                                                                                                                                                          |
| 負荷/攻撃シミュレーション | k6 (JS) または Python + httpx             | レート制御を明示的に書けるものを使う(後述の AWS ポリシー遵守のため)                                                                                                                                                                                                            |
| 脆弱性スキャン            | OWASP ZAP (Docker, baseline scan)         | CI から回せて結果が JSON で取れる                                                                                                                                                                                                                                              |
| ログ分析                  | Amazon Athena                             | WAF ログの誤検知分析をクエリとして残す                                                                                                                                                                                                                                         |

**禁止事項**: CSS-in-JS、`eval` / `new Function` を使うライブラリ、CDN からの外部スクリプト読み込み(すべて self-host する)。

---

## 2. 全体アーキテクチャ

```
                    ┌──────────────────────────────────────────┐
                    │  us-east-1                                │
                    │  WafEdgeStack                             │
                    │   └ WebACL (scope: CLOUDFRONT)            │
                    └──────────────┬───────────────────────────┘
                                   │ (crossRegionReferences)
  ┌────────────────────────────────┼─────────────────────────────────────────┐
  │ ap-northeast-1                 │                                          │
  │                                ▼                                          │
  │  DeliveryStack                                                            │
  │   ├ Cognito App Client(public, PKCE 必須)                               │
  │   ├ CloudFront [hardened]  ── WebACL あり / ResponseHeadersPolicy あり     │
  │   │    ├ default behavior  → S3 (OAC)                                     │
  │   │    ├ /api/*            → API Gateway (CSP レポート収集)                │
  │   │    └ viewer-request CF Function (SPA rewrite)                         │
  │   └ CloudFront [baseline]  ── WebACL なし / ヘッダなし                     │
  │        └ default behavior  → 同一 S3 バケット (OAC)                        │
  │                                                                           │
  │  CoreStack                                                                │
  │   ├ S3 (Block Public Access, OAC 経由のみ許可, アクセスログ有効)            │
  │   ├ Cognito UserPool + Managed Login ドメイン                             │
  │   ├ API Gateway (HTTP API) + Lambda  … CSP violation collector            │
  │   └ Athena Workgroup + Glue Table (WAF ログ用)                            │
  │                                                                           │
  │  WafCognitoStack                                                          │
  │   └ WebACL (scope: COGNITO_USER_POOL) → UserPool に関連付け               │
  └───────────────────────────────────────────────────────────────────────────┘
```

### 2.1 なぜ CloudFront を 2 本立てるのか(実装時に消さないこと)

同一の S3 オリジン・同一のビルド成果物に対して、防御あり/なしを **同時刻に** 測定するため。
時系列で before/after を取ると、ネットワーク状況やスキャナのバージョン差が交絡する。
コストが問題になる場合のみ `-c baselineEnabled=false` で無効化できるようにする。

### 2.2 CDK context フラグ(必須)

`cdk deploy -c <key>=<value>` で挙動を切り替えられること。既定値はカッコ内。

| key               | 値                                        | 効果                                                        |
| ----------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `phase`           | `p0` / `p1` / `p2` / `p3` (`p0`)          | 後述の実験フェーズ。ヘッダと WAF の強度を一括で切り替える   |
| `cspMode`         | `off` / `report-only` / `enforce` (`off`) | CSP の適用モード                                            |
| `trustedTypes`    | `true` / `false` (`false`)                | CSP に `require-trusted-types-for 'script'` を追加          |
| `wafAction`       | `count` / `block` (`count`)               | マネージドルールグループの上書きアクション                  |
| `baselineEnabled` | `true` / `false` (`true`)                 | ベースライン用ディストリビューションの作成                  |
| `vulnMode`        | `true` / `false` (`false`)                | フロントに意図的な DOM-XSS シンクを含めてビルド(実験 E8 用) |

`phase` は上記の個別フラグのプリセットとして実装し、個別フラグが明示された場合はそちらを優先する。

---

## 3. ディレクトリ構成

```
.
├─ infra/
│  ├─ bin/app.ts
│  ├─ lib/core-stack.ts
│  ├─ lib/waf-edge-stack.ts          # us-east-1 / scope=CLOUDFRONT
│  ├─ lib/waf-cognito-stack.ts       # ap-northeast-1 / scope=COGNITO_USER_POOL
│  ├─ lib/delivery-stack.ts          # CloudFront x2 + ResponseHeadersPolicy + CF Function
│  ├─ config/security-headers.ts     # ヘッダ定義の単一情報源
│  ├─ config/csp.ts                  # CSP ディレクティブ定義(バージョン履歴つき)
│  ├─ config/waf-rules.ts            # ルールグループ定義の単一情報源
│  ├─ functions/spa-router/          # CloudFront Function
│  ├─ functions/csp-collector/       # Lambda (Node 22)
│  └─ test/                          # cdk assertions によるスナップショット/単体テスト(Vitest、`vp test` で実行)
├─ web/
│  ├─ src/
│  │  ├─ auth/            # react-oidc-context 設定
│  │  ├─ pages/           # Home / Protected / Profile
│  │  └─ lab/             # vulnMode 時のみバンドルされる検証用コンポーネント
│  └─ vite.config.ts      # vp dev / vp build の設定 + verify:no-inline 等の Vite Task 定義
├─ experiments/
│  ├─ E1-zap/             # ZAP baseline scan ラッパ
│  ├─ E2-headers/         # ヘッダ取得・採点スクリプト
│  ├─ E3-csp/             # CSP 違反レポート集計
│  ├─ E4-waf-tuning/      # Athena クエリ + 誤検知分析
│  ├─ E5-rate/            # レート制限検証(k6)
│  ├─ E6-credstuffing/    # Cognito ログイン試行シミュレーション
│  ├─ E7-overhead/        # レイテンシ・コスト測定
│  ├─ E8-xss/             # CSP による XSS 影響範囲検証
│  └─ results/            # 生データ(コミットする)
└─ docs/
   ├─ SPEC.md             # 本ファイル
   ├─ PLAN.md
   ├─ OPEN_QUESTIONS.md
   └─ RUNBOOK.md          # 実験手順書
```

---

## 4. 詳細要件

### 4.1 CoreStack

- **S3**: `blockPublicAccess: BLOCK_ALL`、SSE-S3 以上、バージョニング有効、サーバアクセスログを別バケットへ。CloudFront からは **OAC (Origin Access Control)** で許可する(OAI は使わない)。
- **Cognito**:
  - User Pool(MFA optional、パスワードポリシーは既定より強め)。
  - App Client は **public client(シークレットなし)**、`authFlow` は Authorization Code のみ、PKCE 必須、暗黙フローは無効。
  - **App Client は DeliveryStack で作る**(2026-08-13 決定、`docs/OPEN_QUESTIONS.md` Q7)。callback / logout URL に CloudFront のドメインが必要な一方、DeliveryStack は CSP のため Cognito ドメインを必要とするため、両方を CoreStack に置くとスタック間で循環参照になる。UserPool とドメインは CoreStack に残す。
  - Managed Login のドメイン(Cognito 既定ドメイン)を作成。機能プランは既定の Essentials とする(2026-08-13 決定、`docs/OPEN_QUESTIONS.md` Q2)。
  - Callback / Logout URL に hardened / baseline 両ディストリビューションのドメインを登録。
- **CSP レポート収集 API**:
  - HTTP API + Lambda。`POST /api/csp-report` のみ。
  - `Content-Type: application/csp-report` と `application/reports+json` の両方を受理する。
  - 受信ボディを構造化 JSON(`effective-directive`, `blocked-uri`, `document-uri`, `script-sample`, UA, 受信時刻)にして CloudWatch Logs へ出力。
  - **CloudFront の `/api/*` ビヘイビアからのみ到達させる**(同一オリジンにすることで CORS を回避する)。Origin Custom Header + Lambda 側検証で直叩きを弾く。
  - スロットリングを設定(違反レポートによる DoS 対策自体がレポートの論点になる)。
- **Athena**: WAF ログ用の Glue テーブル定義と Workgroup(クエリ結果は専用バケット)。

### 4.2 DeliveryStack

#### ResponseHeadersPolicy(hardened のみ)

以下を付与する。`infra/config/security-headers.ts` に一元定義し、テストで検証すること。

| ヘッダ                                            | 値                                                                                                                                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Strict-Transport-Security`                       | `max-age=63072000; includeSubDomains` (※`preload` は既定で付けない。付与時の不可逆性をレポートで論じる)                                                                                                               |
| `X-Content-Type-Options`                          | `nosniff`                                                                                                                                                                                                             |
| `X-Frame-Options`                                 | `DENY`                                                                                                                                                                                                                |
| `Referrer-Policy`                                 | `strict-origin-when-cross-origin`                                                                                                                                                                                     |
| `Permissions-Policy`                              | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()` (※`interest-cohort` は FLoC 廃止に伴い陳腐化したため後継の `browsing-topics` に置換。2026-08-13 決定、`docs/OPEN_QUESTIONS.md` Q4) |
| `Cross-Origin-Opener-Policy`                      | `same-origin`                                                                                                                                                                                                         |
| `Cross-Origin-Resource-Policy`                    | `same-origin`                                                                                                                                                                                                         |
| `Content-Security-Policy` (または `-Report-Only`) | 4.3 参照                                                                                                                                                                                                              |
| `Reporting-Endpoints`                             | `csp-endpoint="/api/csp-report"`                                                                                                                                                                                      |
| `Server` / `x-amz-*`                              | 不要な情報の除去を検討し、可否を記録                                                                                                                                                                                  |

- `cspMode=report-only` のときは **`Content-Security-Policy-Report-Only`** として出す。CDK の `ResponseHeadersPolicy` のネイティブ CSP フィールドは enforce 用なので、Report-Only は `customHeadersBehavior` で付与する。
- baseline ディストリビューションには **一切付けない**。

#### キャッシュ

- `index.html`: `Cache-Control: no-store`(CSP や nonce 相当の値を変えたときに即時反映させるため)。
- ハッシュ付きアセット: `max-age=31536000, immutable`。

#### SPA ルーティング

- **CloudFront の「カスタムエラーレスポンス 403→/index.html (200)」は使わない。** viewer-request の CloudFront Function でパス書き換えを行う。
- 理由: WAF による block も 403 として現れるため、カスタムエラーレスポンスを使うと **ブロックされた事実が 200 の index.html にすり替わって見えなくなる恐れがある**。この挙動差は実験 E4 の検証項目として `docs/RUNBOOK.md` に手順を書くこと(実測で確認する)。
- WAF block 時のカスタムレスポンス(403、`Content-Type: application/json`、識別用のカスタムヘッダ)を WebACL 側で定義し、ブロックが計測可能であることを保証する。

### 4.3 CSP 設計

`infra/config/csp.ts` にバージョン付きで定義する(v1 → v4 の変遷そのものがレポートの成果物)。

```
default-src 'none';
script-src 'self';
style-src 'self';
img-src 'self' data:;
font-src 'self';
connect-src 'self' https://cognito-idp.<region>.amazonaws.com https://<cognito-domain>.auth.<region>.amazoncognito.com;
form-action 'self' https://<cognito-domain>.auth.<region>.amazoncognito.com;
frame-ancestors 'none';
base-uri 'none';
object-src 'none';
upgrade-insecure-requests;
report-uri /api/csp-report;
report-to csp-endpoint;
```

- `trustedTypes=true` のとき `require-trusted-types-for 'script'; trusted-types default;` を追加。
- **`'unsafe-inline'` / `'unsafe-eval'` は最終形に含めないこと。** 含めないと動かないライブラリが出た場合は、ライブラリを差し替えるか `docs/OPEN_QUESTIONS.md` に上げる。
- Vite 側で inline script が生成されないよう `build.modulePreload.polyfill = false` を設定し、ビルド後の `dist/index.html` に inline `<script>` / `<style>` が無いことを検査するスクリプトを `vite.config.ts` の Vite Task として定義し、`vp run verify:no-inline` で実行できるようにする。
- nonce 方式を採らない理由(静的ホスティングではリクエスト毎の HTML 書き換えができず、Lambda@Edge が必要になる)を `docs/` にメモとして残す。レポートの「代替案の検討」節で使う。

### 4.4 WafEdgeStack(scope: CLOUDFRONT, us-east-1 必須)

`infra/config/waf-rules.ts` に定義。優先度順:

| 優先度 | ルール                                                                 | 既定アクション                                                                 |
| ------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 10     | `AWSManagedRulesAmazonIpReputationList`                                | `wafAction` に従う                                                             |
| 20     | `AWSManagedRulesAnonymousIpList`                                       | **常に Count 開始**(VPN/Tor 利用者の誤検知が出やすく、FP 分析の主要素材になる) |
| 30     | `AWSManagedRulesCommonRuleSet`                                         | `wafAction` に従う                                                             |
| 40     | `AWSManagedRulesKnownBadInputsRuleSet`                                 | `wafAction` に従う                                                             |
| 50     | `AWSManagedRulesSQLiRuleSet`                                           | Count 開始                                                                     |
| 100    | RateBased: 全パス、IP 単位、5 分あたり閾値(context で変更可、既定 300) | Block                                                                          |
| 110    | RateBased: `/api/*` のみ、閾値を低く(既定 100)                         | Block                                                                          |
| 200    | GeoMatch(国別可視化用)                                                 | 常に Count                                                                     |

- 各ルールに CloudWatch メトリクスを有効化し、ルール名をレポートの表と一致させる。
- ルールグループ内の個別ルールを除外(exclude)する場合は、**必ずコード内コメントで理由と根拠となる観測日時を書く**。
- ロギング: WAF ログを S3 へ(Athena 用)。`authorization` / `cookie` ヘッダは **redact 設定** を入れること。

### 4.5 WafCognitoStack(scope: COGNITO_USER_POOL)

- Managed Login でのログインは CloudFront を経由せず Cognito のドメインに直接行くため、**エッジ WAF ではログイン試行を保護できない**。よってユーザープールに直接 WebACL を関連付ける。
- ルール: **RateBased(IP 単位、閾値低め)のみ**。
- **ATP(`AWSManagedRulesATPRuleSet`)は使わない**(2026-08-13 確認・決定): ATP / ACFP ルールグループを含む WebACL は Cognito ユーザープールに関連付けできない(AWS 現行仕様)。経緯・出典は `docs/OPEN_QUESTIONS.md` Q1、判断は `docs/DECISIONS.md` の ADR に記録する。
- WebACL のユーザープール関連付け自体は全機能プラン(Lite/Essentials/Plus)で可能で、課金は WAF 側のみ。ただし Managed Login へのリクエストは **body が WAF に転送されない**(ヘッダ・パス等のみ検査可能、PII マッチ不可)ため、ルールは IP・レートベースで設計する。

### 4.6 フロントエンド

- 画面は最小限で良い: 未認証トップ / ログイン / 認証必須ページ / ID トークンのクレーム表示。
- `vulnMode=true` のときのみ `web/src/lab/VulnerableSearch.tsx` をルーティングに追加する。
  - URL クエリ `?q=` の値を `dangerouslySetInnerHTML` に流し込む、意図的な DOM-XSS シンク。
  - ビルド時に `vulnMode` が false ならバンドルに含まれないこと(tree-shaking をテストで確認)。
  - ファイル冒頭に「検証専用。本番配布禁止」の大きなコメントを置く。
- `.env` に相当する値(User Pool ID、ドメイン等)はビルド時に CDK 出力から生成する仕組みにする(手書きさせない)。

### 4.7 実験スクリプト(`experiments/`)

すべて「実行 → `experiments/results/<experiment-id>/<timestamp>/` に生データと集計 CSV/JSON を出力」する形に統一する。レポートの図表はこの CSV から生成する。

| ID  | 目的                                                                                                                                                                                          | 実装                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| E1  | ZAP baseline scan を hardened / baseline 両方に実行し、リスク別アラート件数を比較                                                                                                             | Docker 実行のシェル + JSON→CSV 変換                   |
| E2  | レスポンスヘッダの取得と採点(自前ルーブリック + 外部採点サービスのスコアを手動記録する欄)                                                                                                     | Node スクリプト                                       |
| E3  | CloudWatch Logs Insights から CSP 違反を集計し、`blocked-uri` × `effective-directive` の頻度表を出す                                                                                          | AWS SDK スクリプト                                    |
| E4  | Athena で WAF ログを分析。ルール別ヒット数、Count のうち正当リクエストと判定した割合(＝誤検知率)を算出                                                                                        | SQL + 実行スクリプト                                  |
| E5  | レートベースルールの発火閾値と回復時間を実測                                                                                                                                                  | k6。**同時実行数と RPS を明示的に上限設定できること** |
| E6  | Cognito Managed Login への試行(存在しないユーザー/誤パスワード)を段階的に実施し、Cognito 側 WebACL のレートベースルールがブロックを開始するまでの試行回数と、ブロック解除までの回復時間を測定 | Python or k6                                          |
| E7  | 同一コンテンツに対する hardened / baseline のレイテンシ p50/p95/p99 を測定し、WAF のオーバーヘッドを定量化                                                                                    | k6                                                    |
| E8  | `vulnMode` でペイロードを注入し、CSP 有無で「外部ドメインへの情報送信が成立するか」を比較                                                                                                     | Playwright(コンソールエラーとネットワークを記録)      |

**E5 / E6 に必ず入れる安全弁**:

- 対象ホストのホワイトリストを持ち、自分のディストリビューション/ユーザープール以外には実行できないようにする。
- 既定の最大 RPS を低く固定し、上げる場合は明示フラグを要求する。
- README に「AWS の侵入テストポリシー上、DoS/DDoS に相当する負荷試験は事前承認が必要。本スクリプトは機能確認に必要な最小限のレートに留める」旨を記載する。

### 4.8 テストと品質

- `infra/test/` に cdk assertions のテスト:
  - hardened ディストリビューションに WebACL と ResponseHeadersPolicy が紐づいていること
  - baseline には紐づいて **いない** こと
  - `cspMode=enforce` のとき `Content-Security-Policy` ヘッダが存在し、値に `'unsafe-inline'` が含まれないこと
  - S3 バケットがパブリックアクセス全ブロックであること
- `cdk-nag` を app に適用(`Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }))`)。抑制は理由必須で `infra/bin/nag-suppressions.ts` に集約する。
  - granular finding(`AwsSolutions-IAM5[Resource::...]` のように ID に `::` を含むもの)は `acknowledge()` の ID 検証に弾かれるため、公開定数 `Validations.ACKNOWLEDGED_RULES_METADATA_KEY` を使って同じ形式のメタデータを直接書く。上流で緩和されたら通常の `acknowledge()` に戻すこと(`docs/OPEN_QUESTIONS.md` Q8)。
- `vp run verify:no-inline` をビルド後に自動実行。
- `vp check`(Oxfmt によるフォーマット / Oxlint による lint / 型チェック)と `vp test`(Vitest によるユニットテスト、`infra/test/` の cdk assertions を含む)を CI の必須ゲートにする。
- GitHub Actions のワークフロー(`vp install` → `vp check` → `vp test` → `cdk synth` → `cdk-nag`、ZAP は手動トリガ)を用意。

---

## 5. 成果物として必ず出力するもの

1. 動作するコードとデプロイ手順(`README.md`)
2. `docs/RUNBOOK.md` — 実験 E1〜E8 の実行手順、所要時間、想定コスト、後片付け手順
3. `docs/DECISIONS.md` — 設計判断の記録(ADR 形式)。最低でも以下を含む:
   - なぜ nonce ではなくハッシュ非依存の `script-src 'self'` としたか
   - なぜカスタムエラーレスポンスではなく CloudFront Function を使ったか
   - なぜエッジ WAF に加えて Cognito 側 WebACL が必要だったか
   - なぜ ATP ルールグループを使わなかったか(Cognito ユーザープールへの関連付け不可という現行仕様上の制約)
   - CSS-in-JS を排除した理由
4. `docs/COST.md` — 概算費用と、放置した場合の月額(WAF / ATP / ログ保管)
5. `docs/TEARDOWN.md` — 課金を止めるための削除手順

---

## 6. Claude Code への注意事項(そのまま伝える)

- CloudFront 用 WebACL は **us-east-1 にしか作れない**。他リソースと同一スタックにしないこと。クロススタック参照は `crossRegionReferences: true` を使う。
- CloudFront **Function はレスポンスボディを書き換えられない**。HTML への nonce 注入が必要になったら Lambda@Edge が要る、という前提で設計すること(今回は注入しない)。
- Cognito Managed Login のドメインは自分のディストリビューションとは別オリジン。CSP の `connect-src` / `form-action` に含める必要がある。
- 「動かないから `'unsafe-inline'` を足す」は禁止。原因を特定して報告すること。
- 秘密情報をコードに埋め込まない。`cdk.context.json` に AWS アカウント ID を含めない。
- 実験結果の数値を **想像で書かない**。未取得の値はプレースホルダのままにし、取得手順を書く。
