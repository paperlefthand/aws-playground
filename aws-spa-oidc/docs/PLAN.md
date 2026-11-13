# 実装計画(PLAN)

docs/SPEC.md を実装するためのフェーズ計画。**各フェーズ完了時に `vp check` / `vp test` / (infra 着手後は) `cdk synth` が通ることを確認して停止し、報告する。`cdk deploy` は実行しない**(デプロイコマンドは README に列挙するのみ)。

作成日: 2026-08-13 / ステータス: **承認済み(2026-08-13)** — 5 章の全レビュー項目に回答済み。決定内容は [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) の各「決定」欄と SPEC.md 反映済み。

---

## 0. 現状確認

- リポジトリはルート直下に Vite+ の素の TypeScript スキャフォールド(`src/main.ts`、React なし)がある状態。
- `docs/` には SPEC.md のみ。`infra/` / `web/` / `experiments/` は未作成。
- `pnpm-workspace.yaml` は catalog 定義のみで `packages:` が無い(ワークスペース化されていない)。

→ SPEC 3 章のディレクトリ構成に合わせ、**ルートのスキャフォールドを `web/` に移設して React 化**し、pnpm ワークスペース(`web` / `infra` / `experiments`)に再編する。

## 1. 事前調査の結果(計画に影響する事実)

SPEC 4.5 の指示どおり、実装前に AWS の現行仕様を確認した。詳細と出典は [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) 参照。

1. **[決定済み: 案(a)] ATP ルールグループは Cognito ユーザープールに関連付け不可**。`AWSManagedRulesATPRuleSet`(および ACFP)を含む WebACL はユーザープールに関連付けできないことが AWS 公式ドキュメントに明記されている。→ **ATP は使わず、`atpEnabled` フラグを削除。Cognito 側 WebACL はレートベースルールのみ。E6 はブロック開始閾値と回復時間の測定として設計**(OPEN_QUESTIONS.md Q1)。
2. WebACL のユーザープール関連付け自体は**全機能プラン(Lite/Essentials/Plus)で利用可能**。プラン要件なし。課金は WAF 側。
3. Cognito の Hosted UI / Managed Login へのリクエストは **body が WAF に転送されない**(ヘッダ等のみ)。またユーザー名・パスワード等の PII にはマッチできない。レートベースルール(IP 単位)は問題なく機能する → E6 の測定設計はこの前提で組む。
4. その他の軽微な確認事項は決定済み: **Managed Login(Essentials プラン既定)を使用 / Lambda は nodejs22.x / `interest-cohort=()` は `browsing-topics=()` に置換**(OPEN_QUESTIONS.md Q2〜Q4)。

## 2. 提案: `phase` コンテキストのプリセット定義(要レビュー)

SPEC 2.2 は `phase` (p0〜p3) を「個別フラグのプリセット」とだけ定義しているため、以下のマッピングを提案する(個別フラグ明示時はそちらが優先、は SPEC どおり):

| phase | cspMode       | wafAction | trustedTypes | 想定シナリオ                            |
| ----- | ------------- | --------- | ------------ | --------------------------------------- |
| `p0`  | `off`         | `count`   | `false`      | 導入前ベースライン計測                  |
| `p1`  | `report-only` | `count`   | `false`      | 観測フェーズ(違反レポート収集・FP 分析) |
| `p2`  | `enforce`     | `count`   | `false`      | CSP のみ強制、WAF は観測継続            |
| `p3`  | `enforce`     | `block`   | `false`      | 全面強制(本番想定)                      |

`trustedTypes` / `baselineEnabled` / `vulnMode` はプリセットに含めず常に個別指定(コスト・実験条件に直結するため)。

## 3. フェーズ分割

### Phase 0: リポジトリ再編 + React SPA 基盤 【完了 2026-08-13】

- pnpm ワークスペース化(`packages: [web, infra, experiments]`)。ルート `package.json` は orchestration 専用に。
- `web/`: React 18 + TypeScript + Tailwind CSS + react-router-dom。既存スキャフォールドの流用はせず SPEC 4.6 の画面構成(未認証トップ / 認証必須ページ / クレーム表示)の骨組みだけ作る(認証結線は Phase 4)。
- CSS-in-JS・eval 系・外部 CDN 読み込みなし(SPEC 1 の禁止事項)。
- `build.modulePreload.polyfill = false` を設定し、`verify:no-inline`(ビルド後の `dist/index.html` に inline `<script>`/`<style>` が無いことを検査)を Vite Task として定義。
- **検証**: `vp install` / `vp check` / `vp build` / `vp run verify:no-inline` / `vp test`(最小のスモークテスト)。

### Phase 1: CDK 基盤 + CoreStack 【完了 2026-08-13】

- `infra/` に CDK v2 (TypeScript) アプリを作成。`bin/app.ts` で context 解決(`phase` プリセット → 個別フラグ上書き)を一元実装し、単体テストを書く。
- `config/security-headers.ts` / `config/csp.ts`(v1〜のバージョン履歴つき)/ `config/waf-rules.ts` の単一情報源モジュールを先に作る(スタックはここからのみ参照)。
- **CoreStack** (ap-northeast-1): S3(BLOCK_ALL、SSE、バージョニング、アクセスログ別バケット)/ Cognito UserPool + public クライアント(Auth Code + PKCE のみ、暗黙フロー無効)+ 既定ドメイン / HTTP API + `csp-collector` Lambda(両 Content-Type 受理、構造化ログ、Origin Custom Header 検証、スロットリング)/ Athena Workgroup + Glue テーブル(WAF ログ用)。
- `cdk-nag`(AwsSolutions)を app に適用。抑制は理由必須で `NagSuppressions` に記述。
- **検証**: `vp check` / `vp test`(context 解決 + cdk assertions)/ `cdk synth`(全 context 組み合わせの代表ケース)。

### Phase 2: WafEdgeStack + DeliveryStack 【完了 2026-08-14】

- **WafEdgeStack** (us-east-1, scope=CLOUDFRONT): SPEC 4.4 の優先度表どおりのルール構成。`wafAction` による上書き、レートベース閾値の context 化、ルール別 CloudWatch メトリクス、WAF ログ S3 出力(`authorization`/`cookie` の redact)、block 時カスタムレスポンス(403 + JSON + 識別ヘッダ)。
- WAF ログバケットは **us-east-1(WafEdgeStack 内)** に作る(OPEN_QUESTIONS Q5 決定)。名前は `infra/config/naming.ts` の決定的な名前を使い、CoreStack の Glue テーブルと一致させる。
- **DeliveryStack** (ap-northeast-1, `crossRegionReferences: true` で WebACL ARN を参照):
  - **Cognito App Client をここで作る**(OPEN_QUESTIONS Q7 決定)。public / PKCE 必須 / Authorization Code のみ / 暗黙フロー無効。callback・logout URL に hardened / baseline 両ディストリビューションのドメインを登録する。
  - hardened / baseline の CloudFront ×2(同一 S3 オリジン・OAC)。baseline は `baselineEnabled` で作成可否切替。
  - ResponseHeadersPolicy は hardened のみ。`cspMode=enforce` はネイティブ CSP フィールド、`report-only` は `customHeadersBehavior`。
  - viewer-request CloudFront Function による SPA rewrite(**カスタムエラーレスポンスは使わない**)。
  - `/api/*` ビヘイビア → HTTP API(Origin Custom Header 付与)。
  - キャッシュ: `index.html` no-store / ハッシュ付きアセット immutable。
- **検証**: cdk assertions(SPEC 4.8 の必須 4 項目: hardened に WebACL+ヘッダあり / baseline になし / enforce 時に `unsafe-inline` 不在 / S3 パブリック全ブロック)+ `cdk synth`。

### Phase 3: WafCognitoStack 【完了 2026-08-14】

- scope=REGIONAL の WebACL をユーザープールに関連付け。ルールはレートベース(IP 単位、閾値低め)のみ。
- ATP は使わない(Q1 決定済み)。「なぜ使わない(使えない)か」の ADR を Phase 6 の DECISIONS.md に記録する。
- WAF ログは ap-northeast-1 のバケットへ。CoreStack に `cognito_waf_logs` Glue テーブルを追加し、エッジ用(`edge_waf_logs`)と分けて E6 から引けるようにする。

### Phase 4: フロントエンド認証 + vulnMode 【完了 2026-08-14】

- `react-oidc-context` + `oidc-client-ts` で Cognito Managed Login(Authorization Code + PKCE)結線。`redirect_uri` はビルド時に焼き込まず実行時の origin から組み立てる(hardened / baseline が同一バンドルを配信するため)。
- CDK 出力(CloudFormation Outputs)から `web/.env.local` 相当を生成するスクリプト(`vp run gen:env` 等)。手書き禁止の仕組み化。
- `vulnMode=true` のときのみ `web/src/lab/VulnerableSearch.tsx` をルーティングに追加(冒頭に「検証専用・本番配布禁止」コメント)。false 時にバンドルへ含まれないことを検証するテスト(ビルド成果物の文字列検査)。
- **検証**: `vp check` / `vp test` / `vp build`(vulnMode 両値)/ `verify:no-inline` / `verify:bundle`(eval・new Function の混入)/ `verify:vuln-mode`(実ビルドでの tree-shaking)。

### Phase 5: 実験スクリプト E1〜E8 【完了 2026-08-14】

- `experiments/` を単一パッケージとして E1〜E8 を SPEC 4.7 の表どおり実装。全スクリプトを「実行 → `experiments/results/<id>/<timestamp>/` に生データ + 集計 CSV/JSON」の形式に統一(共通ヘルパを先に作る)。
- E5/E6 の安全弁: 対象ホストのホワイトリスト(CDK 出力由来のみ許可)、既定 RPS 低固定 + 引き上げは明示フラグ、AWS 侵入テストポリシーの注意書き。
- k6 / ZAP(Docker)/ Playwright は実行環境依存のため、スクリプト自体の単体テスト(引数検証・ホワイトリスト・集計ロジック)を Vitest で書く。
- **検証**: `vp check` / `vp test`。実機実行は行わない(手順は RUNBOOK へ)。

### Phase 6: ドキュメント + CI 【完了 2026-08-14】

- `README.md`(デプロイコマンド列挙: bootstrap → synth → deploy 順、context 例つき)。
- `docs/RUNBOOK.md`(E1〜E8 手順・所要時間・想定コスト・後片付け。SPEC 4.2 の「403 カスタムエラーレスポンス使用時の挙動差の実測手順」を含む)。
- `docs/DECISIONS.md`(ADR: nonce 不採用 / CF Function 採用 / Cognito 側 WebACL / CSS-in-JS 排除 の 4 件以上)。
- `docs/COST.md` / `docs/TEARDOWN.md`。
- GitHub Actions: `vp install` → `vp check` → `vp test` → `cdk synth`(cdk-nag は synth 時に評価)。ZAP は手動トリガ(workflow_dispatch)。
- **検証**: `vp check` / `vp test` / `cdk synth` / ワークフローの静的検証(actionlint 相当は手元では YAML 構文確認まで)。

## 4. 横断ルール(全フェーズ共通)

- 実験結果の数値は書かない。プレースホルダ + 取得手順のみ(SPEC 6)。
- `'unsafe-inline'` / `'unsafe-eval'` を足して解決しない。動かない場合は原因特定して報告。
- AWS アカウント ID・シークレットをコードや `cdk.context.json` に含めない。
- SPEC と現行 AWS 仕様の食い違いを見つけたら、その場で直さず OPEN_QUESTIONS.md に追記して報告。

## 5. レビュー項目(全件回答済み 2026-08-13)

1. OPEN_QUESTIONS Q1(ATP × Cognito 不可)→ **案(a) 採用**。
2. 2 章の `phase` プリセット定義 → **承認**。
3. 既存ルートスキャフォールドを廃棄して `web/` を新規作成 → **承認**。
4. OPEN_QUESTIONS Q2〜Q4 → **Managed Login 既定 / nodejs22.x / `browsing-topics=()` 置換**。
