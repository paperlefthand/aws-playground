# sam-restapi

`main.tsp` (TypeSpec) で定義した User Service REST API の TypeScript Lambda 実装。AWS SAM でビルド・ローカル実行・デプロイする。

## 構成

- `main.tsp` — API スペックの源 (TypeSpec)
- `src/` — Lambda コード (TypeScript, esbuild でバンドル)
  - `handler.ts` — Lambda エントリポイント
  - `router.ts` — `httpMethod` + `path` のディスパッチ
  - `routes/` — エンドポイント実装 (現状はスタブ)
- `tests/` — Jest 単体テスト
- `template.yaml` — SAM テンプレート (API Gateway + Lambda + DynamoDB)
- `samconfig.toml` — `sam deploy` 既定設定 (環境固有値は含まない)
- `scripts/deploy.mjs` — `npm run deploy` の実体。環境変数から S3 バケット名と AWS プロファイル名を読み取り `sam deploy` の引数として渡す

## 前提

- Node.js 22 以上
- AWS SAM CLI
- Docker (SAM local 用)

## セットアップ

```bash
npm install
cp .env.example .env   # 値を埋める (詳細は「環境変数」セクション)
```

## 環境変数

`.env` (gitignore) に環境ごとの値を書き、`npm run local:api` / `npm run local:invoke` / `npm run deploy` が `dotenv-cli` で自動読み込みする。テンプレートは [.env.example](.env.example)。

- `AWS_PROFILE` — SAM CLI が credentials を解決するのに使う AWS プロファイル名
- `SAM_S3_BUCKET` — `sam deploy` のアップロード先 S3 バケット名 (`--s3-bucket` に渡る)

## OpenAPI 生成

`main.tsp` から OpenAPI 仕様を生成する:

```bash
npm run openapi
```

これにより 2 つのファイルが生成される:

- `openapi/openapi.yaml` — 純粋な OpenAPI 仕様 (ドキュメント・他 emitter 用)。出力先・バージョンは `tspconfig.yaml` で設定
- `openapi/openapi-aws.yaml` — 上記に各 operation の `x-amazon-apigateway-integration` (Lambda proxy 統合) を注入したもの。`template.yaml` の `AWS::Serverless::Api.DefinitionBody` から `AWS::Include` で取り込まれ、API Gateway のルーティングに使われる

注入処理は [scripts/inject-apigw-integration.mjs](scripts/inject-apigw-integration.mjs) が担当。Lambda ARN は `Fn::Sub` を埋めておき、CloudFormation 側で解決させる。

`sam build` / `sam local` / `sam deploy` を実行する前に必ず `npm run openapi` を走らせる。

## 単体テスト

```bash
npm test
```

## SAM local (Docker)

事前準備:

- Docker Desktop を起動しておく (`sam local` は Lambda を Docker コンテナで実行する)
- `.env` に `AWS_PROFILE` を設定しておく

```bash
npm run build               # = sam build (esbuild でバンドル)
npm run local:api           # API Gateway を localhost:3000 で起動
```

別ターミナルで:

```bash
curl -i http://127.0.0.1:3000/me -H 'Authorization: Bearer u-1:member'
curl -i http://127.0.0.1:3000/users -H 'Authorization: Bearer u-1:admin'
```

`Authorization` ヘッダはスタブ実装で `Bearer <userId>:<role>` 形式を受け付ける (例: `u-1:admin`)。

## デプロイ

デプロイ先の S3 バケット名と AWS プロファイル名は環境ごとに違うので、`samconfig.toml` には書かず、`.env` から `dotenv-cli` 経由で `sam deploy` の引数に渡す (`SAM_S3_BUCKET` → `--s3-bucket`、`AWS_PROFILE` → `--profile`)。

`s3_prefix` (バケット内のパス) は環境非依存なので `samconfig.toml` に `sam/sam-restapi` として固定してある。

```bash
npm run deploy
```

`npm run deploy` の追加引数はそのまま `sam deploy` に渡る (例: `npm run deploy -- --guided`)。

## スタック削除

スタックと付随リソース (Lambda / API Gateway / DynamoDB / IAM ロール / S3 上のアーティファクト) を一括削除する:

```bash
npm run destroy
```

実体は `sam delete --stack-name sam-restapi --no-prompts`。`AWS_PROFILE` は `.env` から `dotenv-cli` 経由で渡る。

### デプロイ失敗からの復旧

初回作成中に失敗するとスタックが `ROLLBACK_COMPLETE` 状態で残り、`npm run deploy` が `Stack ... is in ROLLBACK_COMPLETE state and can not be updated` で失敗する。この状態のスタックは更新不可・削除のみ可能なので、以下で復旧する:

```bash
npm run destroy
npm run deploy
```

更新中に失敗して `UPDATE_ROLLBACK_FAILED` になった場合は、AWS コンソールから問題リソースを「Skip」して `continue-update-rollback` する必要があるため `npm run destroy` では復旧できない。

## 備考

- `main.tsp` の型は `src/types.ts` に手動で同期している。
- API Gateway のパス/メソッドは `main.tsp` → `openapi/openapi-aws.yaml` から流れてくる。Lambda 内では `src/router.ts` が同じパスを再ディスパッチする (proxy integration のため)。
- DynamoDB テーブルは枠だけ用意してあり、スタブ実装段階では使用していない。
