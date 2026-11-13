# 費用

**この文書に実測値は書かない。** 単価は AWS の公開価格(確認日つき)、実測欄は
Cost Explorer で確認して埋める(SPEC 6: 未取得の値を想像で書かない)。

料金は変わるので、判断の前に必ず出典を開いて確認すること。

---

## 1. 何に課金されるか

放置したときに効いてくる順。**リクエストが 0 でも発生する固定費**が
このラボの主な出費になる。

| サービス             | 課金の単位                                          | このラボでの数量                                                        |
| -------------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| AWS WAF              | WebACL 単位の月額 + ルール単位の月額 + リクエスト数 | WebACL 2 個(エッジ / Cognito)、ルール 9 個(エッジ 8 + Cognito 1)        |
| S3                   | 保管量 + リクエスト                                 | SPA 成果物(数 MB)+ WAF ログ + CloudFront アクセスログ + S3 アクセスログ |
| CloudFront           | データ転送 + リクエスト                             | ディストリビューション 2 本。**存在するだけの固定費は無い**             |
| CloudWatch Logs      | 取り込み量 + 保管量                                 | CSP コレクタ、API アクセスログ(保管 30 日)                              |
| Cognito              | 月間アクティブユーザー                              | 実験用の数ユーザー                                                      |
| Athena               | スキャンしたデータ量                                | E4 のクエリ実行時のみ                                                   |
| Lambda / API Gateway | 呼び出し数                                          | CSP 違反レポートの受信のみ                                              |
| Secrets Manager      | シークレット単位の月額                              | 1 個                                                                    |

### 固定費(リクエスト 0 でも毎月かかるもの)

AWS WAF の公開価格(2026-08-14 確認、[AWS WAF Pricing](https://aws.amazon.com/waf/pricing/)):

- WebACL: **$5.00 / 月 / WebACL**
- ルール: **$1.00 / 月 / ルール**
- リクエスト: **$0.60 / 100 万リクエスト**

このラボの構成に当てはめると:

| 項目                                            | 数量 | 月額            |
| ----------------------------------------------- | ---- | --------------- |
| WebACL(エッジ)                                  | 1    | $5.00           |
| WebACL(Cognito)                                 | 1    | $5.00           |
| ルール(エッジ: マネージド 5 + レート 2 + Geo 1) | 8    | $8.00           |
| ルール(Cognito: レート 1)                       | 1    | $1.00           |
| **WAF の固定費 合計**                           |      | **$19.00 / 月** |

これに Secrets Manager(シークレット 1 個)と、S3 / CloudWatch Logs の保管量が
乗る。**リクエストが無くても毎月発生する**ので、使わない期間は
[TEARDOWN.md](TEARDOWN.md) の手順で消すこと。

### ATP を使わない理由(費用面)

ATP / ACFP は **$10.00 / 月 / WebACL のサブスクリプション**に加え、分析した
リクエストに応じた従量課金(0〜200 万リクエストの帯で **$1,000 / 100 万リクエスト**)
がかかる(同上、2026-08-14 確認)。

ただし本ラボが ATP を使わない一次的な理由は費用ではなく、**Cognito ユーザープールに
関連付けできないという仕様上の制約**([DECISIONS.md](DECISIONS.md) ADR-004 /
[OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) Q1)。

### 変動費で跳ねやすいもの

- **WAF ログの S3 保管**: 実験でリクエストを大量に投げると増える。ライフサイクル
  ルールを入れていないので、**放置すると増え続ける**。
- **Athena のスキャン量**: E4 のクエリは必ず `year/month/day` で絞ること。
  絞らないと全期間を走査して跳ねる。パーティション射影を設定してあるので
  `MSCK REPAIR` は不要。
- **CloudFront のクロスリージョン読み取り**: エッジ WAF のログバケットは
  us-east-1、Athena は ap-northeast-1 にあるため、E4 のクエリはリージョンをまたぐ
  データ転送が発生する([OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) Q5)。

---

## 2. 実測値(デプロイ後に埋める)

Cost Explorer で「タグ `project = edge-defense-lab`」で絞ると、このラボの費用だけを
見られる(全スタックにタグを付けてある)。

```bash
aws ce get-cost-and-usage \
  --time-period Start=YYYY-MM-DD,End=YYYY-MM-DD \
  --granularity MONTHLY --metrics UnblendedCost \
  --filter '{"Tags":{"Key":"project","Values":["edge-defense-lab"]}}' \
  --group-by Type=DIMENSION,Key=SERVICE
```

| サービス             | 実測(USD) | 期間 | 備考 |
| -------------------- | --------- | ---- | ---- |
| AWS WAF              |           |      |      |
| S3                   |           |      |      |
| CloudFront           |           |      |      |
| CloudWatch           |           |      |      |
| Cognito              |           |      |      |
| Athena               |           |      |      |
| Lambda / API Gateway |           |      |      |
| Secrets Manager      |           |      |      |
| **合計**             |           |      |      |

> Cost Explorer への反映には最大 24 時間かかる。実験当日の値は出ない。

### 実験ごとの追加費用(実測して埋める)

| 実験             | 追加費用(USD) | 主な内訳                                |
| ---------------- | ------------- | --------------------------------------- |
| E1 (ZAP)         |               | CloudFront リクエスト、WAF リクエスト   |
| E4 (Athena)      |               | Athena スキャン量、クロスリージョン転送 |
| E5 / E6 (レート) |               | WAF リクエスト                          |
| E7 (k6)          |               | CloudFront データ転送、WAF リクエスト   |

---

## 3. 放置した場合の月額

**WAF の固定費だけで約 $19 / 月**(上表)。これに Secrets Manager と、
実験で貯まった WAF ログ / CloudFront ログの S3 保管料が加わる。
ログは自動で消えないので、月を追うごとに増える。

使わない期間は [TEARDOWN.md](TEARDOWN.md) で全削除するのが確実。
再構築は `cdk deploy --all` で数十分。
