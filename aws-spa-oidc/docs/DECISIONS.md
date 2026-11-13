# 設計判断の記録 (ADR)

実装中に迷った点と、なぜその結論にしたかの記録。**代替案を検討した事実そのもの**が
レポートの材料になるので、却下した案とその理由も残す。

---

## ADR-001: CSP を nonce ではなく `script-src 'self'` で構成する

**状態**: 採用(2026-08-13)

**文脈**: CSP で inline script を止める方法は主に 3 つある。(a) `'nonce-...'`、
(b) `'sha256-...'` ハッシュ、(c) inline script を一切作らず `'self'` だけで通す。

**判断**: (c) を採る。`script-src 'self'` のみとし、nonce もハッシュも使わない。

**理由**: nonce は **リクエストごとに異なる値を HTML に埋める**必要がある。S3 +
CloudFront の静的ホスティングでは HTML はキャッシュされた同一のバイト列が返るため、
リクエスト単位の書き換えができない。実現するには Lambda@Edge(origin-response)で
HTML を書き換えることになり、次の代償が生じる:

- 全リクエストに Lambda@Edge の実行時間が乗り、**E7 のレイテンシ測定に
  「CSP の方式の違い」ではなく「Lambda@Edge の有無」が混ざる**
- Lambda@Edge の課金が増える
- CloudFront Function ではレスポンスボディを書き換えられないため代用できない

Vite のビルドは inline script を作らないので、`'self'` だけで成立する。実際に
そうなっていることは `vp run verify:no-inline` が毎ビルド検査している。

**却下した案**: ハッシュ方式。ビルドのたびにハッシュが変わり、CSP を CDK 側で
持っている以上インフラの再デプロイが必要になる。フロントの変更とインフラの
デプロイが結合するのは実験の回転を落とす。

**結果**: CSP に `'unsafe-inline'` / `'unsafe-eval'` を含めずに済んでいる。
混入は `infra/config/csp.ts` の `assertNoUnsafeSources` が synth 時に、
`vp run verify:bundle` がビルド時に検査する。

---

## ADR-002: SPA ルーティングにカスタムエラーレスポンスを使わず CloudFront Function を使う

**状態**: 採用(2026-08-13)

**文脈**: SPA のクライアントサイドルーティングを成立させるには、S3 に存在しない
パス(`/protected` など)で `index.html` を返す必要がある。CloudFront の
「カスタムエラーレスポンス 403 → `/index.html` を 200 で返す」が定番の手法。

**判断**: カスタムエラーレスポンスは使わない。viewer-request の CloudFront Function
でパスを書き換える。

**理由**: **WAF によるブロックも 403 として現れる**。カスタムエラーレスポンスを
設定すると、WAF がブロックした結果まで 200 の `index.html` にすり替わり、
「ブロックされた」という事実が観測できなくなる。防御の効果測定が目的の本ラボでは
致命的で、測定値が静かに壊れる種類の問題なので構成で避ける。

CloudFront Function はレスポンスボディを書き換えられないが、ここで必要なのは
リクエストパスの書き換えだけなので足りる。

**結果**: WAF のブロックは 403 のまま観測できる。オリジン由来の 403 と切り分ける
ため、WebACL 側で `x-lab-blocked-by: waf` を付けている
(`infra/config/waf-rules.ts`)。実験側の判定は `experiments/lib/waf.mjs`。
この挙動差そのものを実測する手順を docs/RUNBOOK.md に置いた。

---

## ADR-003: エッジ WAF に加えて Cognito 側にも WebACL を関連付ける

**状態**: 採用(2026-08-13)

**文脈**: CloudFront に WebACL を付ければアプリ全体を守れそうに見える。

**判断**: それでは足りない。ユーザープールに直接 WebACL を関連付ける
(`WafCognitoStack`)。

**理由**: Managed Login でのログインは **CloudFront を経由しない**。ブラウザは
Cognito のドメイン(`<prefix>.auth.<region>.amazoncognito.com`)へ直接飛ぶため、
エッジの WebACL はログイン試行を 1 件も見られない。認証まわりが最も攻撃を受ける
面であるにもかかわらず、エッジ WAF だけでは完全な死角になる。

**結果**: ログイン面のレート制限が測定可能になった(実験 E6)。
なお Managed Login へのリクエストは **body が WAF に転送されない**ため、
ユーザー名・パスワードにはマッチできない。ルールは IP 単位のレートベースのみ。

---

## ADR-004: ATP ルールグループを使わない

**状態**: 採用(2026-08-13)

**文脈**: SPEC は当初、Cognito スコープの WebACL に AWS WAF Fraud Control の
Account Takeover Prevention (`AWSManagedRulesATPRuleSet`) を任意で足す想定だった。

**判断**: 使わない。`atpEnabled` フラグ自体を削除した。

**理由**: **ATP / ACFP を含む WebACL は Cognito ユーザープールに関連付けできない**
(AWS の現行仕様)。関連付け済みの WebACL への後付け追加も不可。
出典と確認日は docs/OPEN_QUESTIONS.md Q1。

**結果**: E6 の測定対象を「認証情報の使い回しの検知」ではなく
「レートベースルールがブロックを開始するまでの試行回数と回復時間」と定義し直した。
**この制約の存在自体がレポートの論点になる** — マネージドな防御機能が、
最も守りたいサービスに適用できないことがある、という具体例。

**代替案**: Cognito Threat Protection(Plus 機能プラン)。WAF ではなく Cognito
ネイティブの機能なので「WAF の効果測定」という枠から外れることと、追加課金を
避けるため採用しなかった。

---

## ADR-005: CSS-in-JS を使わない

**状態**: 採用(2026-08-13)

**文脈**: React で広く使われる Emotion / styled-components / MUI は、実行時に
`<style>` 要素を DOM に注入する。

**判断**: CSS-in-JS を禁止し、Tailwind CSS(ビルド時に静的な CSS ファイルを出力)を使う。

**理由**: 実行時の `<style>` 注入は `style-src 'unsafe-inline'` を要求する。
`'unsafe-inline'` を入れた時点で **CSP の実験の主旨が失われる**。「動かないから
`'unsafe-inline'` を足す」を後から迫られないよう、最初から成立する技術選定にする。

**結果**: `style-src 'self'` のまま成立している。ビルド成果物に inline `<style>` が
無いことは `vp run verify:no-inline` が毎回検査する。

---

## ADR-006: S3 のバケットポリシーでディストリビューションを個別に指定しない

**状態**: 採用(2026-08-14)

**文脈**: OAC の推奨構成では、S3 バケットポリシーの `AWS:SourceArn` に
CloudFront ディストリビューションの ARN を書いて対象を限定する。

**判断**: `arn:aws:cloudfront::<account>:distribution/*` のワイルドカードにする。

**理由**: バケットは `CoreStack`、ディストリビューションは `DeliveryStack` にある。
バケットポリシーに個別の ARN を書くと「CoreStack → DeliveryStack」の参照が生まれ、
DeliveryStack はバケットを参照しているので **スタック間で循環参照**になり
デプロイできない。

同じ理由で、DeliveryStack 側ではバケットを **名前でインポート**している
(`Bucket.fromBucketName`)。CDK の `S3BucketOrigin.withOriginAccessControl()` は
バケットポリシーを自動で書き換えようとするが、インポートしたバケットには
書き込まないため循環が起きない。

**残るリスク**: 同一アカウント内の別の CloudFront ディストリビューションからも
読めてしまう。Block Public Access と `aws:SecureTransport` は効いているので、
アカウント外には公開されない。本番構成なら個別 ARN にすべきで、その場合は
バケットとディストリビューションを同じスタックに置くのが素直。

---

## ADR-007: Origin Custom Header の共有値をシークレット「名」で参照する

**状態**: 採用(2026-08-14)

**文脈**: CSP レポート API の直叩きを防ぐため、CloudFront が Origin Custom Header に
共有値を載せ、Lambda 側で検証する。同じ値が 2 つのスタックで必要になる。

**判断**: Secrets Manager のシークレットに **固定名** を付け、両スタックが
その名前から `{{resolve:secretsmanager:<名前>:SecretString:::}}` という
**リテラルな動的参照文字列** を組み立てる(`infra/config/naming.ts`)。

**理由**: シークレットを ARN でクロススタック参照すると、動的参照の文字列の中に
`Fn::ImportValue` が入り込む。CloudFormation は動的参照を文字列として前処理するため、
組み込み関数が混ざった形では解釈されない。名前で参照すればどちらのスタックも
他方に依存せずリテラルを作れる。

**結果**: 値そのものはコードにもテンプレートにも載らない(SPEC 6)。
テンプレートに載るのは参照だけで、テストで固定している。

**この方式の落とし穴(実測で判明 / 2026-08-14)**: シークレットを **名前** で参照すると、
CloudFormation の依存グラフにその関係が現れない。作成時はたまたま順序が合っても、
**削除時にシークレットが先に消え、動的参照を持つリソースの削除が
`ResourceNotFoundException` で失敗する**(`cdk destroy` で CoreStack が DELETE_FAILED)。

対策として `collector.node.addDependency(originSecret)` で依存を明示している。
**この動的参照を新たに使うリソースを足すときは、同じ依存を必ず張ること。**
`infra/test/core-stack.test.ts` が `DependsOn` の存在を検査している。

なお別スタック(DeliveryStack の CloudFront)からの参照は
`deliveryStack.addStackDependency(coreStack)` があるためスタック単位で順序が守られる。

**未検証**: CloudFront の `OriginCustomHeaders` が動的参照を解決するかは
デプロイしないと分からない。確認手順と失敗時の代替案(context で値を渡す方式)は
docs/OPEN_QUESTIONS.md Q9 (1)。

---

## ADR-008: cdk-nag は v3 を使い、granular finding だけメタデータで抑制する

**状態**: 採用(2026-08-13)

**文脈**: cdk-nag v3 は `NagSuppressions` を廃止し、CDK ネイティブの
`Validations.of(scope).acknowledge({ id, reason })` に移行した。

**判断**: v3 を使う。ただし granular finding
(`AwsSolutions-IAM5[Resource::<arn>]` のように ID に `::` を含むもの)は、
公開定数 `Validations.ACKNOWLEDGED_RULES_METADATA_KEY` を使って
`acknowledge()` と同じ形のメタデータを直接書き込む。

**理由**: `Validations.acknowledge()` は ID を `::` で分割して
「プレフィックス::ルール名」と解釈し、`::` が 2 つ以上あると
`InvalidValidationId` で落ちる。granular finding の ID は必ず `::` を含むため、
公開 API 経由では抑制できない(cdk-nag 3.0.2 / aws-cdk-lib 2.264.0 で実測)。

**副次的な効果**: 抑制できない指摘を減らす過程で、Lambda の実行ロールから
AWS 管理ポリシー(`AWSLambdaBasicExecutionRole`)を外し、自身のロググループに
だけ書ける最小権限ロールに置き換えた。結果として `AwsSolutions-IAM4` の指摘は
消えており、posture は改善している。

**壊れやすさへの対策**: 抑制 ID には対象リソースの ARN 文字列がそのまま入る。
`Stack.formatArn()` を使うと認証情報の有無でアカウント / リージョンが具体値に
解決され、**環境ごとに ID が変わって抑制が外れる**。そのため IAM ポリシー側は
擬似パラメータで ARN を組み立て、組み立てを 1 関数に集約している。
`infra/test/nag.test.ts` が実際に `app.synth()` して回帰を防いでいる。

---

## ADR-009: 実験の対象ホストを CDK 出力からしか受け取らない

**状態**: 採用(2026-08-14)

**文脈**: 負荷や攻撃をシミュレートするスクリプトは、対象を間違えると第三者に
迷惑をかける。SPEC 4.7 は「対象ホストのホワイトリストを持つ」ことを求めている。

**判断**: 対象 URL をコマンドライン引数で受け取らない。`infra/cdk-outputs.json` に
現れたホストだけを許可し、HTTP アクセスは全て `labFetch` を経由させる
(`experiments/lib/`)。

**理由**: 「ホワイトリストを検査する関数を用意する」だけでは、新しいスクリプトが
検査を通さずに `fetch` を呼ぶ余地が残る。対象の指定経路自体を塞ぐほうが確実。

**結果**: 自分がデプロイしたリソース以外は実行時に例外になる。テストで
`example.com` のような対象が拒否されることを固定している。
