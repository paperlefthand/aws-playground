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
- 単一 Lambda 内でルーティングする構成。
- DynamoDB テーブルは枠だけ用意してあり、スタブ実装段階では使用していない。
