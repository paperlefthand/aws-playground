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

これにより 3 つのファイルが生成される:

- `openapi/openapi.yaml` — 純粋な OpenAPI 仕様 (ドキュメント・他 emitter 用)。出力先・バージョンは `tspconfig.yaml` で設定
- `openapi/openapi-aws.yaml` — 上記に各 operation の `x-amazon-apigateway-integration` (Lambda proxy 統合) を注入したもの。`template.yaml` の `AWS::Serverless::Api.DefinitionBody` から `AWS::Include` で取り込まれ、API Gateway のルーティングに使われる
- `src/types.ts` — `openapi-typescript` で `openapi.yaml` から生成した TypeScript 型 (`paths` / `components` / `operations`)。Lambda 実装側はここから `components["schemas"]["User"]` の形で参照する

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

> SAM local では API Gateway の Cognito Authorizer は適用されない (Authorizer をエミュレートしない)。そのため local では Cognito の ID Token は不要で、引き続き `Bearer <userId>:<role>` 形式のスタブが通る。デプロイ後の挙動を試す場合は [認証 (Cognito)](#認証-cognito) を参照。

### デバッグ実行 (VS Code からアタッチ)

`sam local start-api` を `-d <port>` 付きで起動すると、Lambda コンテナが Node の inspector を当該ポートで開く。`--warm-containers EAGER` を併用してコンテナを使い回さないと、リクエスト毎に新コンテナが立ち上がる際に 5858 ポートが衝突して 502 になる。

```bash
npm run local:api:debug     # localhost:3000 で API, 5858 で inspector を待ち受け
```

VS Code 側は [.vscode/launch.json](.vscode/launch.json) の `Attach to SAM Local` を実行する。`template.yaml` の esbuild は `Sourcemap: true` だが、SAM が一時ディレクトリで TS をコンパイルする都合で sourcemap の `sources` が消滅した一時パスを指すため、`npm run build` の中で [scripts/fix-sourcemaps.mjs](scripts/fix-sourcemaps.mjs) が `.aws-sam/build/**/*.js.map` の `sources` を `src/**/*.ts` に書き戻している。これにより TypeScript の元コードにそのままブレークポイントを置ける。

別ターミナルでリクエストを投げるとブレークポイントで停止する:

```bash
curl -i http://127.0.0.1:3000/me -H 'Authorization: Bearer u-1:member'
```

## 認証 (Cognito)

API Gateway に Cognito User Pool Authorizer (`cognito_user_pools`) を設定している。Authorization ヘッダで Cognito User Pool が発行する **ID Token** (JWT) を `Bearer <token>` 形式で渡す。Access Token ではないので注意。

- User Pool / User Pool Client は `template.yaml` の `CognitoUserPool` / `CognitoUserPoolClient` でスタックに同梱。セルフサインアップ有効、`USER_PASSWORD_AUTH` 許可、クライアントシークレットなし。
- Authorizer 定義は OpenAPI 側に注入される ([scripts/inject-apigw-integration.mjs](scripts/inject-apigw-integration.mjs))。`securitySchemes.CognitoAuth` の `x-amazon-apigateway-authorizer` が `providerARNs: ${CognitoUserPool.Arn}` を指す。
- 公開エンドポイント (`GET /users/{userId}/followers`, `GET /users/{userId}/posts`) は `main.tsp` で `@useAuth(NoAuth)` を付けているので認証不要。それ以外は ID Token が無いと `401 Unauthorized` を返す。

### 1. スタック Outputs から ID と URL を取得

```bash
aws cloudformation describe-stacks \
  --stack-name sam-restapi \
  --profile "$AWS_PROFILE" \
  --query "Stacks[0].Outputs" \
  --output table
```

`UserPoolId`, `UserPoolClientId`, `ApiUrl` を環境変数にセット:

```bash
export USER_POOL_ID=ap-northeast-1_xxxxxxxxx
export CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
export API_URL=https://xxxxxxxxxx.execute-api.ap-northeast-1.amazonaws.com/Prod
```

### 2. ユーザー作成 (サインアップ + 管理者確認)

メール確認をスキップして即時利用可能にするため、サインアップ後に管理者として `admin-confirm-sign-up` を叩く:

```bash
aws cognito-idp sign-up \
  --client-id "$CLIENT_ID" \
  --username you@example.com \
  --password 'Passw0rd!' \
  --user-attributes Name=email,Value=you@example.com \
  --profile "$AWS_PROFILE"

aws cognito-idp admin-confirm-sign-up \
  --user-pool-id "$USER_POOL_ID" \
  --username you@example.com \
  --profile "$AWS_PROFILE"
```

### 3. ID Token を取得

```bash
ID_TOKEN=$(aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id "$CLIENT_ID" \
  --auth-parameters USERNAME=you@example.com,PASSWORD='Passw0rd!' \
  --query "AuthenticationResult.IdToken" \
  --output text \
  --profile "$AWS_PROFILE")
```

PowerShell の場合:

```powershell
$ID_TOKEN = aws cognito-idp initiate-auth `
  --auth-flow USER_PASSWORD_AUTH `
  --client-id $env:CLIENT_ID `
  --auth-parameters "USERNAME=you@example.com,PASSWORD=Passw0rd!" `
  --query "AuthenticationResult.IdToken" `
  --output text `
  --profile $env:AWS_PROFILE
```

### 4. curl で API を呼び出す

```bash
# 認証必須エンドポイント
curl -i "$API_URL/me" -H "Authorization: Bearer $ID_TOKEN"

# 公開エンドポイント (ヘッダ不要)
curl -i "$API_URL/users/u-1/followers"

# ヘッダなしで認証必須エンドポイントを叩くと 401
curl -i "$API_URL/me"
```

### トークンの再取得

ID Token のデフォルト有効期限は 60 分。期限切れ後は Refresh Token で更新できる:

```bash
ID_TOKEN=$(aws cognito-idp initiate-auth \
  --auth-flow REFRESH_TOKEN_AUTH \
  --client-id "$CLIENT_ID" \
  --auth-parameters "REFRESH_TOKEN=$REFRESH_TOKEN" \
  --query "AuthenticationResult.IdToken" --output text \
  --profile "$AWS_PROFILE")
```

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

- `src/types.ts` は `npm run openapi` で `openapi/openapi.yaml` から自動生成される (gitignore 対象)。`main.tsp` を変更したら必ず `npm run openapi` を流してから commit する。
- API Gateway のパス/メソッドは `main.tsp` → `openapi/openapi-aws.yaml` から流れてくる。Lambda 内では `src/router.ts` が同じパスを再ディスパッチする (proxy integration のため)。
- DynamoDB テーブルは枠だけ用意してあり、スタブ実装段階では使用していない。
