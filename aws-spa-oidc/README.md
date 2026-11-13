# エッジ多層防御ラボ

CloudFront + S3 + Cognito 上の React SPA に対して、**WAF / セキュリティヘッダ / CSP の
効果を定量測定する**ための実験環境。防御ありの構成(hardened)と防御なしの構成
(baseline)を **同一のビルド成果物・同一の S3 オリジン** に対して同時に立て、
同時刻に比較する。

- 仕様: [docs/SPEC.md](docs/SPEC.md)
- 実装計画と進捗: [docs/PLAN.md](docs/PLAN.md)
- 未決事項・仕様との差異: [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md)
- 設計判断 (ADR): [docs/DECISIONS.md](docs/DECISIONS.md)
- 実験手順: [docs/RUNBOOK.md](docs/RUNBOOK.md)
- 費用: [docs/COST.md](docs/COST.md) / 後片付け: [docs/TEARDOWN.md](docs/TEARDOWN.md)

## 構成

| スタック          | リージョン     | 中身                                                                                           |
| ----------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `CoreStack`       | ap-northeast-1 | S3(SPA / アクセスログ)、Cognito User Pool + Managed Login、CSP レポート収集 API、Athena + Glue |
| `WafEdgeStack`    | **us-east-1**  | CLOUDFRONT スコープの WebACL とそのログバケット                                                |
| `WafCognitoStack` | ap-northeast-1 | COGNITO_USER_POOL スコープの WebACL(ユーザープールに関連付け)                                  |
| `DeliveryStack`   | ap-northeast-1 | CloudFront ×2(hardened / baseline)、Cognito App Client                                         |

CLOUDFRONT スコープの WebACL は us-east-1 にしか作れないため別スタックにしている。

## 必要なもの

- Node.js 24 以上(`vp env` が管理)
- AWS CLI v2 と、対象アカウントへの管理者相当の権限
- 実験ごとの外部ツール: Docker(E1)、k6(E7)、Playwright(E8)

## セットアップ

```bash
vp install          # 依存のインストール
vp check            # フォーマット / lint / 型チェック
vp test             # ユニットテスト(CDK assertions を含む)
```

## デプロイ

> **`cdk deploy` は必ず `cdk` CLI から実行すること。**
> クロスリージョン参照のため、合成済みテンプレートを
> `aws cloudformation deploy` に直接渡すことはできない(docs/OPEN_QUESTIONS.md Q10)。

### 1. ブートストラップ(初回のみ、**2 リージョン必要**)

```bash
cd infra
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
npx cdk bootstrap "aws://${ACCOUNT}/ap-northeast-1" "aws://${ACCOUNT}/us-east-1"
```

### 2. スタックのデプロイ

段階導入は `-c phase=` で切り替える(既定は `p0`)。

```bash
cd infra
npx cdk deploy --all --outputs-file cdk-outputs.json -c phase=p0
```

| phase | cspMode       | wafAction | 用途                                       |
| ----- | ------------- | --------- | ------------------------------------------ |
| `p0`  | `off`         | `count`   | 導入前ベースライン計測                     |
| `p1`  | `report-only` | `count`   | 観測フェーズ(違反レポート収集・誤検知分析) |
| `p2`  | `enforce`     | `count`   | CSP のみ強制、WAF は観測継続               |
| `p3`  | `enforce`     | `block`   | 全面強制(本番想定)                         |

個別フラグは `phase` のプリセットより優先される。

```bash
# 例: p1 のまま Trusted Types だけ試す
npx cdk deploy --all --outputs-file cdk-outputs.json -c phase=p1 -c trustedTypes=true

# 例: コストを抑えるため baseline を作らない(比較実験はできなくなる)
npx cdk deploy --all --outputs-file cdk-outputs.json -c baselineEnabled=false

# 例: レート閾値を下げて E5 を短時間で回す
npx cdk deploy --all --outputs-file cdk-outputs.json -c rateLimitApi=20
```

利用できる context は [docs/SPEC.md](docs/SPEC.md) 2.2 を参照。

### 3. フロントエンドの設定生成とビルド

CDK の出力から `web/.env.local` を生成する。**値は手書きしない。**

```bash
vp run gen:env                  # infra/cdk-outputs.json から生成
vp build
vp run verify:no-inline         # inline <script>/<style> が無いこと
vp run verify:bundle            # eval / new Function が無いこと
```

### 4. S3 へ配置

`index.html` だけ `no-store` にする(CSP を変えたときに古い HTML が残らないように)。

```bash
BUCKET=$(jq -r '.[] | select(.SiteBucketName) | .SiteBucketName' infra/cdk-outputs.json)

aws s3 sync web/dist "s3://${BUCKET}/" --delete \
  --exclude index.html \
  --cache-control "public, max-age=31536000, immutable"

aws s3 cp web/dist/index.html "s3://${BUCKET}/index.html" \
  --cache-control "no-store" --content-type "text/html; charset=utf-8"
```

### 5. キャッシュの無効化

```bash
for ID in $(aws cloudfront list-distributions \
  --query "DistributionList.Items[?contains(Comment, 'edge-lab')].Id" --output text); do
  aws cloudfront create-invalidation --distribution-id "$ID" --paths '/*'
done
```

### 6. 動作確認用のユーザーを作る

セルフサインアップは無効にしてあるので、管理者が作成する。

```bash
POOL_ID=$(jq -r '.[] | select(.UserPoolId) | .UserPoolId' infra/cdk-outputs.json)
aws cognito-idp admin-create-user \
  --user-pool-id "$POOL_ID" \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true
```

## 実験の実行

[docs/RUNBOOK.md](docs/RUNBOOK.md) に E1〜E8 の手順・所要時間・想定コスト・
後片付けをまとめてある。負荷を伴う実験には安全弁があるので
[experiments/README.md](experiments/README.md) も必ず読むこと。

## 後片付け

放置すると WAF とログ保管で課金が続く。[docs/TEARDOWN.md](docs/TEARDOWN.md) を参照。

```bash
cd infra && npx cdk destroy --all
```
