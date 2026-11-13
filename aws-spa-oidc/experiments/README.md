# 実験スクリプト E1〜E8

SPEC 4.7 の実験。すべて **実行 → `experiments/results/<experiment-id>/<timestamp>/` に
生データと集計 CSV/JSON を出力** に統一してある。レポートの図表はこの CSV から作る。

詳しい手順・所要時間・想定コストは [docs/RUNBOOK.md](../docs/RUNBOOK.md) を参照。

## 共通の前提

すべての実験は CDK の出力ファイルから対象を解決する。先に infra/ で:

```bash
npx cdk deploy --all --outputs-file cdk-outputs.json
```

## 安全弁(必ず読むこと)

AWS の侵入テストポリシー上、**DoS / DDoS に相当する負荷試験は事前承認が必要**。
本スクリプト群はレート制限の発火を確認するのに必要な最小限のレートに留めており、
以下の制約をコードで強制している(`lib/targets.mjs` / `lib/safety.mjs`)。

- **対象は CDK 出力に現れたホストのみ。** それ以外は実行時に例外になる。
  コマンドラインで任意のホストを指定することはできない。
- **既定のレートは低く固定**(10 rps / 5 VU / 60 秒)。超える指定は
  `--i-have-load-test-approval` を付けない限り拒否される。
- 明示フラグを付けても **絶対上限**(200 rps / 50 VU / 900 秒)は超えられない。
- 総試行回数にも上限があり、暴走しても止まる。

## 一覧

| ID  | 目的                                                                  | 実行                                                                    | 外部ツール |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------- |
| E1  | ZAP baseline scan のリスク別アラート件数を hardened / baseline で比較 | `node experiments/E1-zap/run.mjs`                                       | Docker     |
| E2  | レスポンスヘッダの取得と採点                                          | `node experiments/E2-headers/run.mjs`                                   | なし       |
| E3  | CSP 違反を `blocked-uri` × `effective-directive` で集計               | `node experiments/E3-csp/run.mjs --log-group=...`                       | AWS CLI    |
| E4  | WAF ログのルール別ヒット数と誤検知率                                  | `node experiments/E4-waf-tuning/run.mjs --database=... --workgroup=...` | AWS CLI    |
| E5  | レートベースルールの発火閾値と回復時間                                | `node experiments/E5-rate/run.mjs`                                      | なし       |
| E6  | Cognito ログイン面のレート制限の発火と回復                            | `node experiments/E6-credstuffing/run.mjs`                              | なし       |
| E7  | hardened / baseline のレイテンシ p50/p95/p99                          | `node experiments/E7-overhead/run.mjs`                                  | k6         |
| E8  | CSP の有無で外部への情報送信が成立するか                              | `node experiments/E8-xss/run.mjs`                                       | Playwright |

## 実装上の注意

**数値を想像で埋めない**(SPEC 6)。観測できなかった値は `null` や空欄のまま出す。
特に:

- E4 の誤検知率は人の判断が要るため 2 段階。まず `labeling.csv` を生成し、
  人が `verdict` 列を埋めてから率を計算する。未判定は分母に入れない。
- E3 で違反 0 件だったときは「違反なし」と即断せず、CSP が実際に配信されているかを
  先に確認する(`report-to` の相対パス問題 / docs/OPEN_QUESTIONS.md Q6)。
- E5 / E6 でブロックを観測できなかった場合、試行回数は `null` になる。
- E1 / E7 / E8 は baseline が無い構成では差分欄が空になる。

**E5 / E6 を Node で書いている理由**: SPEC の表は k6 を挙げているが、これらで
測りたいのはスループットではなく「何回目でブロックされたか」という逐次の回数であり、
レート上限・総試行上限・ホワイトリストをプロセス内で強制できるほうが安全弁として
確実なため。負荷とレイテンシの測定(E7)には k6 を使う。

**E6 はパスワード試行を行わない**。Managed Login へのリクエストは body が WAF に
転送されず、評価対象は IP 単位のレートだけになる(SPEC 4.5)。実在ユーザーの
アカウントロックやパスワード試行ログを汚さずに、測りたいものだけを測る。
