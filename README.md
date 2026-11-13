# aws-playground

AWS のサンプル集です。各ディレクトリが独立したプロジェクトになっています。

| ディレクトリ | 内容 | 主なツール |
| --- | --- | --- |
| [aws-spa-oidc](aws-spa-oidc/) | SPA + OIDC (Cognito) + WAF の検証環境 | pnpm (Vite+), CDK |
| [ec2-alb](ec2-alb/) | EC2 (FastAPI) + ALB | CDK, uv (Python) |
| [ecs-bg-deployment](ecs-bg-deployment/) | ECS Blue/Green デプロイ | CDK |
| [sam-restapi](sam-restapi/) | API Gateway + Lambda の REST API | SAM, TypeSpec |

## VS Code

`aws-playground.code-workspace` を開きます(「ファイル > ファイルでワークスペースを開く」)。

```bash
code aws-playground.code-workspace
```

- 各サンプルが別々のルートフォルダとして表示されます。設定・デバッグ構成・推奨拡張機能は
  各サンプルの `.vscode/` に置いてあり、そのフォルダにだけ適用されます。
- `(root)` フォルダはリポジトリ直下のファイル(`.gitignore`、`.github/` など)の編集用です。
- ターミナルを開くときは対象のサンプルフォルダを選びます(direnv がそのサンプルの環境変数を読み込みます)。

## 開発環境のセットアップ

### Node.js

各サンプルの `.node-version` でバージョンを固定しています(Vite+ の `vp` が自動で切り替えます)。
`sam-restapi` は Lambda のランタイム (`nodejs22.x`) に合わせて 22、それ以外は 26 です。

### direnv (AWS プロファイルの切り替え)

サンプルごとに `.envrc` があり、ディレクトリに入ると `.env` の `AWS_PROFILE` を読み込みます。
親シェルの `AWS_PROFILE` は引き継がないため、意図しないアカウントにデプロイすることを防げます。

```bash
sudo apt install direnv
echo 'eval "$(direnv hook bash)"' >> ~/.bashrc
```

各サンプルで以下を一度だけ実行します。

```bash
cp .env.example .env   # AWS_PROFILE を設定する
direnv allow
```

### Python (ec2-alb)

`ec2-alb/app` は [uv](https://docs.astral.sh/uv/) で管理しています。手順は [ec2-alb/README.md](ec2-alb/README.md) を参照してください。

## CI

GitHub Actions のワークフローは `.github/workflows/<サンプル名>-*.yml` に置きます。
`paths` フィルタで、そのサンプルに変更があったときだけ実行します。
