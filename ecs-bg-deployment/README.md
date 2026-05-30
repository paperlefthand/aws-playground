# ECS Blue/Green Deployment with CDK

ECS Fargate + CodeDeploy による Blue/Green デプロイのハンズオン構成です。

## 構成

- VPC (2AZ, NAT Gateway x1)
- ECS Fargate サービス (nginx)
- ALB (本番リスナー: 80, テストリスナー: 8080)
- CodeDeploy による Blue/Green デプロイ
- CloudWatch Logs (`/ecs/ecs-bg-deployment`)
- **Application Auto Scaling** (ALB RequestCountPerTarget ベースのターゲット追跡, 1〜6 タスク)
- **Container Insights** 有効化 + **CloudWatch ダッシュボード** (`ecs-bg-loadtest`)

## 前提

AWS CLI プロファイルを環境変数に設定しておきます。

```bash
export AWS_PROFILE=sandbox
```

## デプロイ手順

### 1. 初回のみ: CDK ブートストラップ

```bash
npm run bootstrap -- --profile $AWS_PROFILE
```

### 2. スタックのデプロイ

```bash
npm run deploy -- --profile $AWS_PROFILE
```

デプロイ完了後、ALB の DNS 名が出力されます。

```text
Outputs:
EcsBgDeploymentStack.AlbDnsName = xxxxxxxx.ap-northeast-1.elb.amazonaws.com
```

## 動作確認

### DNS 名の取得

```bash
ALB_DNS=$(aws cloudformation describe-stacks \
  --stack-name EcsBgDeploymentStack \
  --query 'Stacks[0].Outputs[?OutputKey==`AlbDnsName`].OutputValue' \
  --output text \
  --profile $AWS_PROFILE)

echo $ALB_DNS
```

### curl でリクエストを送信

```bash
curl http://$ALB_DNS
```

### CloudWatch Logs でログを確認

```bash
aws logs tail /ecs/ecs-bg-deployment --follow --profile $AWS_PROFILE
```

特定の時間帯のログを確認する場合:

```bash
aws logs tail /ecs/ecs-bg-deployment \
  --since 10m \
  --profile $AWS_PROFILE
```

## 負荷試験でスケールアウトを可視化する実験

K6 で ALB に負荷をかけ、ECS が自動でスケールアウト/スケールインする様子を
CloudWatch ダッシュボードで観測します。

### しくみ

- ALB の **RequestCountPerTarget** が 1タスクあたり毎分 50 リクエストを超えると
  Application Auto Scaling が発火し、タスクが最大 6 個までスケールアウトします。
- 負荷が下がるとスケールインして 1 タスクに戻ります。
- nginx の静的ページは CPU をほぼ消費しないため、CPU ではなくリクエスト数を指標にしています。

### 2. 負荷試験の実行

```bash
ALB_DNS=$(aws cloudformation describe-stacks \
  --stack-name EcsBgDeploymentStack \
  --query 'Stacks[0].Outputs[?OutputKey==`AlbDnsName`].OutputValue' \
  --output text --profile $AWS_PROFILE)

k6 run -e TARGET_URL=http://$ALB_DNS loadtest/script.js
```

ステージ構成（合計 5 分）:

| フェーズ | 時間 | VU | 目的 |
| --- | --- | --- | --- |
| ランプアップ | 1分 | →100 | 徐々に負荷を上げる |
| 高負荷 | 3分 | →200 | スケールアウト観測 |
| ランプダウン | 1分 | →0 | スケールイン観測 |

### 3. CloudWatch ダッシュボードで観測

デプロイ時に出力される `DashboardUrl` を開くか、コンソールで `ecs-bg-loadtest` ダッシュボードを開きます。

| パネル | 見どころ |
| --- | --- |
| **ECS Running Task Count** | 負荷試験の**数分後**に 1 → 2 以上に増える（スケールアウト）。試験終了後にさらに数分待つと 1 に戻る（スケールイン） |
| **ECS CPU / Memory Utilization** | nginx は CPU をほぼ消費しない（実測値 < 0.3%）。CPU ベースのスケーリングでは発火しないことが分かる |
| **ALB Request Count / Per Target** | スケーリングのトリガー。負荷投入中に急上昇する |
| **ALB Target Response Time** | 正常系は中央値 ~17ms と高速。スケールアウト前後で劣化しないことを確認できる |

> **スケールアウトのタイミングについて**
> CloudWatch メトリクスの反映遅延（1〜3分）＋クールダウン 60 秒のため、
> タスク数の増加は負荷試験終了後に観測されることがあります。これは正常な動作です。

CLI でもタスク数の推移を確認できます:

```bash
CLUSTER=$(aws ecs list-clusters --profile $AWS_PROFILE --query 'clusterArns[0]' --output text)
SERVICE=$(aws ecs list-services --cluster $CLUSTER --profile $AWS_PROFILE --query 'serviceArns[0]' --output text)
aws ecs describe-services --cluster $CLUSTER --services $SERVICE \
  --query 'services[0].{desired:desiredCount,running:runningCount}' --profile $AWS_PROFILE
```

### 4. K6 結果の見方

試験終了後に表示される主な指標:

| 指標 | 見方 |
| --- | --- |
| `checks_succeeded` | `status is 200` の成功率。スケールアウト時に新タスクがターゲットグループへ登録される瞬間、一部リクエストがタイムアウトし 1〜2% 程度失敗することがある（正常な挙動） |
| `http_req_duration` (成功のみ) | avg ~70ms、中央値 ~17ms が目安。avgがsに達する場合はタイムアウト件数が多く外れ値の影響 |
| `http_req_failed` | 1〜2% 程度であればスケールアウト時の過渡的な失敗。10% を超える場合は `requestsPerTarget` のしきい値調整を検討 |
| `vus_max` | 実際に到達した最大 VU 数。200 が表示されれば最高負荷に達している |

> **注意**: Container Insights / NAT Gateway / ALB / Fargate の稼働でコストが発生します（1サイクルあたり約 $0.2〜0.5）。
> 実験後は `npm run destroy` でスタックを破棄してください。
> しきい値 `requestsPerTarget` はローカルから出せる RPS に応じて
> [lib/ecs-bg-deployment-stack.ts](lib/ecs-bg-deployment-stack.ts) で調整できます。

## スタックの削除

```bash
npm run destroy -- --profile $AWS_PROFILE
```

## その他のコマンド

| コマンド | 説明 |
| --- | --- |
| `npm run build` | TypeScript のコンパイル |
| `npm run watch` | ファイル変更を監視してコンパイル |
| `npm run synth -- --profile $AWS_PROFILE` | CloudFormation テンプレートの生成 |
| `npm run diff -- --profile $AWS_PROFILE` | デプロイ済みスタックとの差分確認 |
| `npm run test` | Jest によるユニットテスト |
