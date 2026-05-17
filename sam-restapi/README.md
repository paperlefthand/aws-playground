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
- `samconfig.toml` — `sam deploy` 既定設定

## 前提

- Node.js 22 以上
- AWS SAM CLI
- Docker (SAM local 用)

## セットアップ

```bash
npm install
```

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

初回:

```bash
sam deploy --guided
```

以降:

```bash
npm run deploy
```

## 備考

- `main.tsp` の型は `src/types.ts` に手動で同期している。
- API Gateway のパス/メソッドは `main.tsp` → `openapi/openapi-aws.yaml` から流れてくる。Lambda 内では `src/router.ts` が同じパスを再ディスパッチする (proxy integration のため)。
- DynamoDB テーブルは枠だけ用意してあり、スタブ実装段階では使用していない。
