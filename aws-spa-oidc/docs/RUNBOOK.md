# 実験手順書 (RUNBOOK)

E1〜E8 の実行手順。**誰が何回やっても同じ手順で同じ数字が取れる**ことを最優先に書く。

- 所要時間は目安(実測ではない)。
- 費用は [COST.md](COST.md) を参照。実測欄はそちらに記録する。
- **測定値を想像で埋めないこと**(SPEC 6)。観測できなかった値は空欄か `null` のまま残す。

---

## 0. 共通の前提

### 0.1 デプロイ済みであること

[README.md](../README.md) の手順でデプロイし、`infra/cdk-outputs.json` があること。
実験スクリプトはこのファイルからしか対象を受け取らない(安全弁 / ADR-009)。

```bash
ls -l infra/cdk-outputs.json
```

### 0.2 安全弁を理解していること

負荷を伴う実験(E5 / E6 / E7)には次の制約がある。詳細は
[experiments/README.md](../experiments/README.md)。

- 対象は CDK 出力に現れたホストのみ。それ以外は実行時に例外になる。
- 既定レートは 10 rps / 5 VU / 60 秒。超えるには `--i-have-load-test-approval` が必要。
- 明示フラグを付けても絶対上限(200 rps / 50 VU / 900 秒)は超えられない。

**AWS の侵入テストポリシー上、DoS / DDoS に相当する負荷試験は事前承認が必要。**
本スクリプト群は機能確認に必要な最小限のレートに留めている。既定を超える設定で
実行する前に、必要な承認を取ること。

### 0.3 フェーズを合わせること

実験ごとに必要な `phase` が違う。**結果に phase を必ず記録する**
(各実験の `metadata.json` に入る)。

| 実験   | 必要な phase               | 理由                                      |
| ------ | -------------------------- | ----------------------------------------- |
| E1, E2 | `p0` と `p2` / `p3` の両方 | 防御前後を比較する                        |
| E3     | `p1`(report-only)          | 違反を集めるが壊さない                    |
| E4     | `p1` 以降                  | WAF ログが必要                            |
| E5, E6 | いずれでも可               | レートベースルールは phase に依らず Block |
| E7     | `p3`                       | 本番想定のオーバーヘッドを測る            |
| E8     | `p0` と `p2` / `p3`        | CSP の有無で比較する                      |

```bash
cd infra && npx cdk deploy --all --outputs-file cdk-outputs.json -c phase=p1
```

---

## 1. デプロイ直後に必ず確認すること

`cdk synth` では検証できず、**デプロイして初めて真偽が分かる**項目
([OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) Q9)。実験を始める前にここを通すこと。
ここが壊れていると、後続の実験が「防御が効いている」ように見えて実は
測定できていない、という状態になる。

所要: 10〜15 分(ログの反映待ちを含む)

### 1.1 CSP レポート API が Origin Custom Header を解決しているか

```bash
HARDENED=$(jq -r '.[] | select(.HardenedUrl) | .HardenedUrl' infra/cdk-outputs.json)

# CloudFront 経由 → 204 が返ること
curl -i -X POST "${HARDENED}/api/csp-report" \
  -H 'content-type: application/csp-report' \
  -d '{"csp-report":{"effective-directive":"script-src","blocked-uri":"smoke-test"}}'
```

- **204** が返る → OK。
- **403** が返る → CloudFront が Secrets Manager の動的参照を解決できていない。
  Q9 (1) の代替案(context で値を渡す方式)に切り替える必要がある。

直叩きが弾かれることも確認する(こちらは 403 が正しい):

```bash
API=$(jq -r '.[] | select(.CspReportApiEndpoint) | .CspReportApiEndpoint' infra/cdk-outputs.json)
curl -i -X POST "${API}/api/csp-report" -H 'content-type: application/csp-report' -d '{}'
```

### 1.2 WAF ログが S3 に届いているか

デプロイから 5〜10 分後、何度かアクセスしてから確認する。

```bash
BUCKET=$(jq -r '.[] | select(.EdgeWafLogBucketName) | .EdgeWafLogBucketName' infra/cdk-outputs.json)
aws s3 ls "s3://${BUCKET}/AWSLogs/" --recursive | head
```

何も出ない場合は CloudTrail で `delivery.logs.amazonaws.com` の AccessDenied を確認
(Q9 (2))。

### 1.3 CloudFront アクセスログが届いているか

反映に最大 1 時間かかる。E1 / E7 の前に確認しておく。

```bash
aws s3 ls "s3://$(aws s3 ls | grep -o 'edge-lab-delivery-cloudfrontaccesslogs[a-z0-9-]*')/" --recursive | head
```

### 1.4 WAF のブロックが 403 のまま観測できるか(SPEC 4.2 の検証)

**この構成の要**。カスタムエラーレスポンスを使っていないので、WAF のブロックは
200 の `index.html` にすり替わらないはず。実測で確かめる。

まず SPA ルーティングが効いていること(存在しないパスで 200 + HTML):

```bash
curl -s -o /dev/null -w '%{http_code}\n' "${HARDENED}/protected"   # → 200
```

次に WAF にブロックさせて 403 が返ること。`/api/*` のレート閾値が低いので、
E5 を実行すればブロック状態を作れる。

```bash
node experiments/E5-rate/run.mjs --rps=10 --max-attempts=400
# ブロック後、別ターミナルで:
curl -i "${HARDENED}/api/csp-report" | head -20
```

**期待する結果**: `HTTP/2 403` と `x-lab-blocked-by: waf` が返り、本文は
`{"message":"Request blocked by AWS WAF","lab":true}`。

**カスタムエラーレスポンスを使った場合との差**を記録するには、一時的に
CloudFront のカスタムエラーレスポンス(403 → /index.html を 200)を
マネジメントコンソールで足して同じ curl を打つ。200 と HTML が返れば、
「ブロックが観測できなくなる」ことの実測になる。**確認後は必ず元に戻すこと。**
この差が ADR-002 の根拠になる。

---

## 2. E1: ZAP baseline scan

**目的**: 受動スキャンのアラート件数を hardened / baseline で比較する。

**必要なもの**: Docker

**所要**: 10〜20 分(2 対象 × 5〜10 分)

```bash
cd infra && npx cdk deploy --all --outputs-file cdk-outputs.json -c phase=p3 && cd ..
node experiments/E1-zap/run.mjs
```

**出力**: `experiments/results/E1-zap/<timestamp>/`

- `hardened-zap.json` / `baseline-zap.json` — ZAP の生レポート
- `risk-summary.csv` — リスク別の件数と差分
- `alerts.csv` — アラート 1 件 1 行

**読み方**: `reduced` 列が「baseline にあって hardened で消えたアラート数」。
セキュリティヘッダ由来のアラート(CSP 不在、X-Frame-Options 不在など)が
ここに現れるはず。

**注意**: baseline scan は受動スキャンのみで攻撃リクエストを投げない。
AWS の事前承認は不要。

---

## 3. E2: レスポンスヘッダの採点

**目的**: セキュリティヘッダの有無を採点し、hardened / baseline を比較する。

**所要**: 1 分未満

```bash
node experiments/E2-headers/run.mjs
```

**出力**: `experiments/results/E2-headers/<timestamp>/`

- `hardened-headers.json` / `baseline-headers.json` — 生ヘッダ(後から採点し直せる)
- `rubric.csv` — 項目別の合否と実際の値
- `external-scores.csv` — **外部採点サービスのスコアを手で書く欄**(空で出る)

**外部スコアの記録手順**:

1. [securityheaders.com](https://securityheaders.com/) などに hardened / baseline の
   URL を入力する
2. `external-scores.csv` の `service` / `grade` / `score` / `measured_at` を埋める

**phase を変えて 2 回実行し、比較する**:

```bash
cd infra && npx cdk deploy --all --outputs-file cdk-outputs.json -c phase=p0 && cd ..
node experiments/E2-headers/run.mjs   # 防御前

cd infra && npx cdk deploy --all --outputs-file cdk-outputs.json -c phase=p3 && cd ..
node experiments/E2-headers/run.mjs   # 防御後
```

---

## 4. E3: CSP 違反レポートの集計

**目的**: `blocked-uri` × `effective-directive` の頻度表を作り、CSP を
どこまで絞れるかの根拠にする。

**前提**: `phase=p1`(report-only)でしばらく運用し、違反を貯めておくこと。
**最低でも数時間、できれば数日**。デプロイ直後に実行しても意味のある数字は出ない。

**所要**: クエリ 2〜3 分(運用期間は別)

```bash
# ロググループ名を調べる
aws logs describe-log-groups \
  --query "logGroups[?contains(logGroupName, 'CspCollector')].logGroupName" --output text

node experiments/E3-csp/run.mjs --log-group=/aws/lambda/... --hours=24
```

**出力**: `experiments/results/E3-csp/<timestamp>/`

- `insights-results.json` — Logs Insights の生結果
- `violations.csv` — 頻度表
- `summary.json` — 件数と、0 件だった場合の注意書き

**0 件だったときにやること**(「違反なし」と即断しない):

1. `curl -I "${HARDENED}/"` で `content-security-policy-report-only` が
   返っているか確認する
2. 手順 1.1 の smoke test で API 自体が生きているか確認する
3. `Reporting-Endpoints` の相対パスが効いていない可能性を疑う
   ([OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) Q6)。`report-uri` 経由なら届くはずなので、
   ブラウザの DevTools で `/api/csp-report` への POST が出ているか見る

**CSP を更新したら**: `infra/config/csp.ts` の `CSP_VERSION_HISTORY` に追記し、
`observedAt` に観測日時、`evidence` にこの結果ディレクトリのパスを書く。
根拠の無いバージョンはテストが落とす。

---

## 5. E4: WAF ログの誤検知分析

**目的**: ルール別ヒット数と、Count のうち正当リクエストだった割合(誤検知率)。

**前提**: `phase=p1` 以降でしばらく運用し、WAF ログが貯まっていること。

**所要**: 集計 5 分 + **ラベル付け(人手)30〜60 分** + 再集計 1 分

### 5.1 集計とラベル付け CSV の生成

```bash
node experiments/E4-waf-tuning/run.mjs \
  --database=edge_lab_waf_logs \
  --workgroup=edge-lab-waf-analysis \
  --table=edge_waf_logs \
  --date=$(date -u +%F)
```

**出力**: `rule-hits.csv`(ルール別ヒット数)、`blocked-requests.csv`、
`labeling.csv`(**`verdict` 列が空**)

### 5.2 ラベル付け(人手)

`labeling.csv` の `verdict` 列を埋める。値は `legitimate` / `attack` / `unknown`。

- `legitimate` — 正当なリクエストなのにルールに当たった(= 誤検知)
- `attack` — 実際に攻撃だった
- `unknown` — 判断がつかない。**分母に入らない**ので、無理に埋めない

判断材料は `uri` / `client_ip` / `country` / `user_agent`。自分が実行した
実験のトラフィック(E1 の ZAP、E5 の負荷)は `attack` 側に寄るので、
**実験の実行時刻と突き合わせて除外するか、別ラベルで管理する**こと。

### 5.3 誤検知率の計算

```bash
node experiments/E4-waf-tuning/run.mjs --labeled=experiments/results/E4-waf-tuning/<ts>/labeling.csv
```

**出力**: `false-positive-rates.csv`

**読み方**: 分母は判定済み(`legitimate` + `attack`)のみ。`unknown` と空欄は
`unlabeled` として別に出る。判定が 1 件も無いルールは率が空欄になる。

**ルールを除外(exclude)する場合**: `infra/config/waf-rules.ts` の
`excludedRules` に追加し、**理由と根拠になった観測日時を `note` に必ず書く**
(SPEC 4.4)。理由の無い除外はテストが落とす。

**Athena のコスト注意**: クエリは必ず `year/month/day` で絞る。
`queries.sql` はそうなっているが、手で書き換えるときは注意。

---

## 6. E5: レートベースルールの閾値と回復時間

**目的**: 設定した閾値で実際にブロックが始まるか、何秒で回復するか。

**所要**: 5〜20 分(回復待ちを含む)

```bash
node experiments/E5-rate/run.mjs                      # /api/* (閾値が低い)
node experiments/E5-rate/run.mjs --path=/             # 全パス側
```

**出力**: `attempts.csv`(1 試行 1 行)、`summary.json`

**読み方**: `attemptsUntilBlocked` が「何回目でブロックされたか」。
`null` ならブロックを観測できていない。その場合は:

- 閾値(`rateLimitApi` / `rateLimitAll`)がレート × 試行回数より高い
- `--max-attempts` を増やすか、閾値を下げて再デプロイする

```bash
cd infra && npx cdk deploy --all --outputs-file cdk-outputs.json -c rateLimitApi=20
```

**WAF ログとの突き合わせ**: E4 の `rate_rule_timeline` クエリで、同じ時刻に
`RateLimitApiPaths` が発火しているかを確認する。実測とログが一致していれば
測定の信頼性が上がる。

**注意**: レートベースルールは 5 分の評価窓で動くため、**連続して実行すると
前回の分がカウントに残る**。1 回測ったら 10 分以上空けること。

---

## 7. E6: Cognito ログイン面のレート制限

**目的**: エッジ WAF では守れないログイン面で、Cognito 側 WebACL が
ブロックを開始するまでの試行回数と回復時間。

**所要**: 5〜20 分

```bash
node experiments/E6-credstuffing/run.mjs
```

**このスクリプトはパスワード試行を行わない。** Managed Login へのリクエストは
body が WAF に転送されず、評価対象は IP 単位のレートだけになるため
(SPEC 4.5 / ADR-003)。実在ユーザーのアカウントロックやパスワード試行ログを
汚さずに、測りたいものだけを測る設計。

**出力**: `attempts.csv`、`summary.json`

**読み方**: `unmarkedForbiddenCount` が 0 でない場合、識別ヘッダの無い 403 が
混ざっている。Managed Login ではカスタムレスポンスが最初の 1 回しか反映されない
仕様のため起こりうる。E4 の `cognito_waf_logs` テーブルと突き合わせて確認する。

**ATP を使っていないことの確認**: この実験で測れるのは「レート」であって
「認証情報の使い回しの検知」ではない。ATP が Cognito に関連付けできないという
制約([OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) Q1)そのものがレポートの論点になる。

---

## 8. E7: レイテンシのオーバーヘッド

**目的**: WAF とセキュリティヘッダによるレイテンシ増を p50 / p95 / p99 で定量化。

**必要なもの**: k6

**前提**: `phase=p3`、かつ `baselineEnabled=true`(比較が目的なので必須)

**所要**: 2〜3 分

```bash
cd infra && npx cdk deploy --all --outputs-file cdk-outputs.json -c phase=p3 && cd ..
node experiments/E7-overhead/run.mjs --vus=5 --duration=60
```

**出力**: `k6-summary.json`(生)、`latency.csv`、`overhead.csv`

**読み方**: `overhead_ms` / `overhead_percent` が hardened − baseline。
**同一時刻に両方へ投げている**ので、ネットワーク状況の変動は相殺される。

**測定の注意**:

- 1 回目はキャッシュが温まっておらず遅い。**2 回以上実行して 2 回目以降を使う**。
- CloudFront のエッジロケーションは実行元の場所で変わる。**同じ場所から実行する**。
- レートを上げると WAF のレート制限に当たる。既定の 5 VU / 1 秒間隔なら当たらない。

**コスト**: データ転送が発生する。[COST.md](COST.md) の実験別欄に記録する。

---

## 9. E8: CSP による XSS 影響範囲の検証

**目的**: XSS が成立したとき、CSP の有無で **外部ドメインへの情報送信が
成立するか** を比較する。

**必要なもの**: Playwright

**前提**: **vulnMode を含むビルドが配置されていること**

```bash
vp -C experiments add -D playwright
npx playwright install chromium

# vulnMode 入りでビルドして配置する
vp run gen:env --vuln-mode
vp build
BUCKET=$(jq -r '.[] | select(.SiteBucketName) | .SiteBucketName' infra/cdk-outputs.json)
aws s3 sync web/dist "s3://${BUCKET}/" --delete --exclude index.html \
  --cache-control "public, max-age=31536000, immutable"
aws s3 cp web/dist/index.html "s3://${BUCKET}/index.html" \
  --cache-control "no-store" --content-type "text/html; charset=utf-8"

cd infra && npx cdk deploy --all --outputs-file cdk-outputs.json -c phase=p3 && cd ..
node experiments/E8-xss/run.mjs
```

**所要**: 5 分(ビルドと配置を含めて 15 分)

**出力**: `observations.json`(生)、`results.csv`、`comparison.csv`

**読み方**: `blocked_by_csp` が 1 なら「baseline では外部送信が成立し、
hardened では止まった」= CSP が効いた。空欄なら片方しか観測できていない。

**ペイロードの送信先は `*.invalid`**(存在しないことが保証された TLD)。
第三者のサイトへリクエストは飛ばない。

### 8.1 実験後は必ず vulnMode を外す

**検証用の脆弱ページを残したまま放置しない。**

```bash
vp run gen:env          # --vuln-mode なしで再生成
vp build
vp run verify:vuln-mode # false のビルドに含まれないことを確認
# 上の aws s3 sync / cp をもう一度実行して配置し直す
```

---

## 10. 実験後の後片付け

1. `experiments/results/` をコミットする(生データも含めて残す)
2. vulnMode を外して再配置する(E8 を実行した場合)
3. しばらく使わないなら [TEARDOWN.md](TEARDOWN.md) で全削除する

**WAF の固定費は月 $19 かかり続ける**([COST.md](COST.md))。
