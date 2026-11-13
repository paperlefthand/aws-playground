# OPEN QUESTIONS

SPEC.md の記述と現行 AWS 仕様の食い違い、および実装前に決定が必要な事項。**回答が付いたら「決定」欄に記入し、該当コードに反映する。**

---

## Q1. 【要決定・Phase 3 ブロッカー】ATP ルールグループは Cognito ユーザープールに関連付けできない

**SPEC の記述** (4.5): 「`atpEnabled=true` のとき `AWSManagedRulesATPRuleSet`」を Cognito スコープの WebACL に追加する。

**現行仕様(2026-08-13 確認)**: `AWS-AWSManagedRulesATPRuleSet`(および ACFP `AWSManagedRulesACFPRuleSet`)を含む WebACL は **Cognito ユーザープールに関連付けできない**。関連付け済み WebACL への後付け追加も不可。AWS 公式ドキュメントに明記:

- [Associate an AWS WAF web ACL with a user pool (Cognito Developer Guide)](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-waf.html) — "You can't associate a web ACL that uses AWS WAF Fraud Control account takeover prevention (ATP) with an Amazon Cognito user pool."
- [ATP rule group (WAF Developer Guide)](https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-atp.html)
- [AWS re:Post: ACFP and ATP not available for user pools](https://repost.aws/questions/QUGtlYfgbiR9i0KhbzbwJCPA/waf-acfp-and-atp-not-available-for-user-pools)

なお ATP の料金(参考): サブスクリプション $10/月 + 分析されたログイン試行に応じた従量課金([AWS WAF Pricing](https://aws.amazon.com/waf/pricing))。

**代替案**:

| 案                                                        | 内容                                                                                                                                                    | 備考                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| (a) ATP を諦める                                          | Cognito 側 WebACL はレートベースルールのみとし、`atpEnabled` フラグを削除。E6(credential stuffing 耐性)はレートベースルールのブロック閾値測定として設計 | 最小コスト。レポートでは「ATP が使えない事実」自体を考察材料にできる                                                                 |
| (b) Cognito Threat Protection(旧 Advanced Security)で代替 | `atpEnabled` を「Cognito の Threat Protection(compromised credentials / adaptive authentication)を有効化する」フラグに読み替える                        | **Plus 機能プランが必要**(追加課金)。WAF ではなく Cognito ネイティブ機能になるため、レポートの「WAF の効果測定」という枠からは外れる |
| (c) フラグは残すが no-op + 警告                           | `atpEnabled=true` 指定時に synth を警告付きで通し、ATP は付与しない                                                                                     | 仕様の痕跡は残るが実験に寄与しない。推奨しない                                                                                       |

**推奨**: (a)。E6 の測定対象を「レートベースルールがブロックを開始するまでの試行回数と回復時間」と明確化し、DECISIONS.md に ADR として「なぜ ATP を使わないか(使えないか)」を記録する。(b) は追加課金と引き換えに「多層防御の比較」素材が増えるため、レポートの狙い次第では併用の価値あり。

**決定**: **(a) 採用**(2026-08-13)。`atpEnabled` フラグは削除。Cognito 側 WebACL はレートベースルールのみとし、E6 は「ブロック開始までの試行回数と回復時間の測定」として設計。DECISIONS.md に ADR を記録する。SPEC.md 2.2 / 4.5 / 4.7 反映済み。

---

## Q2. Managed Login と classic Hosted UI のどちらを使うか

**SPEC の記述** (4.1): 「Hosted UI ドメイン(Cognito 既定ドメイン)を作成」。

**現行仕様(2026-08-13 確認)**: 現在の Cognito はログイン UI に 2 世代ある(新規プールの既定は Essentials プラン + Managed Login)。WebACL は **どちらの UI でも全機能プラン(Lite/Essentials/Plus)で関連付け可能**であり、SPEC が懸念していた「機能プラン要件」は WebACL 関連付けに関しては**存在しない**(課金は WAF 側のみ)。ただし:

- Hosted UI / Managed Login へのリクエストは **body が WAF に転送されない**(ヘッダ・パス等のみ検査可能)。ユーザー名・パスワード等 PII へのマッチ不可。→ E6 はレート(IP 単位・試行回数)ベースで設計する。
- CAPTCHA アクションは Managed Login の TOTP 登録と干渉する既知の問題あり(本実験では CAPTCHA ルールを使わない予定なので影響なし)。

**質問**: 既定(Essentials + Managed Login)で進めてよいか。classic Hosted UI 指定の意図があれば教えてほしい。CSP の `connect-src` / `form-action` に入れるドメイン形式はどちらでも `<prefix>.auth.<region>.amazoncognito.com` で同一。

**決定**: **既定(Essentials + Managed Login)で進める**(2026-08-13)。SPEC.md 1 / 4.1 / 4.5 反映済み。

---

## Q3. Lambda ランタイムバージョン

**SPEC の記述** (3 章): 「functions/csp-collector/ # Lambda (Node 20)」。

**現状**: nodejs20.x は現役だが、nodejs22.x が利用可能で新規実装の標準。実験環境の寿命を考えると 22 を推奨(サポート期限が長い)。

**質問**: nodejs22.x に変更してよいか。

**決定**: **nodejs22.x を使う**(2026-08-13)。SPEC.md 3 章反映済み。

---

## Q4. Permissions-Policy の `interest-cohort=()` は陳腐化している

**SPEC の記述** (4.2): `Permissions-Policy: ... interest-cohort=()`。

**現状**: `interest-cohort` は FLoC(廃止済み)向けディレクティブで、現行ブラウザは認識せず無視する(後継の Topics API は `browsing-topics`)。付けても害はないが、ヘッダ採点(E2)で「未知のディレクティブ」として扱われる可能性がある。

**質問**: (a) SPEC どおり残す、(b) `browsing-topics=()` に置換、(c) 両方付ける、のいずれにするか。レポートで「ヘッダ仕様の変遷」として言及する素材にもなるため、(c) 両方付ける + DECISIONS.md に注記、を推奨。

**決定**: **(b) `browsing-topics=()` に置換**(2026-08-13)。SPEC.md 4.2 反映済み。

---

## Q5. 【要確認・Phase 2 に影響】WAF ログバケットのリージョンと Athena の関係

**背景**: SPEC 2 のアーキテクチャ図では Athena / Glue が CoreStack(ap-northeast-1)にある一方、CLOUDFRONT スコープの WebACL は us-east-1 にしか置けない。

**確認できた事実**(2026-08-13、[Sending web ACL traffic logs to an S3 bucket](https://docs.aws.amazon.com/waf/latest/developerguide/logging-s3.html)):

- S3 ログ配信先バケットは **WebACL と同一アカウント**かつ **`aws-waf-logs-` で始まる名前**であることが必須。
- オブジェクトキーは `AWSLogs/<account>/WAFLogs/<Region>/<web-acl-name>/<YYYY>/<MM>/<dd>/<HH>/<mm>/`。ここの `<Region>` は **WebACL のリージョン**であってバケットのリージョンではない。よって CLOUDFRONT スコープでは常に `us-east-1` になる。
- **バケットが WebACL と同一リージョンである必要があるかは公式ドキュメントに明記されていない**(CloudWatch Logs 配信先については同一リージョン必須と書かれているが、S3 については記載なし)。

**実装済みの方針**: `infra/config/naming.ts` で決定的なバケット名を定義し、Glue テーブルの location をその名前で組み立てる。クロススタック参照(リージョンまたぎ + 循環)を回避している。バケットのリージョンはパスに影響しないため、**この設計はバケットをどちらに置いても壊れない**。

**決めてほしいこと**: エッジ WAF のログバケットを Phase 2 でどちらに作るか。

| 案       | 置き場所                                     | 利点                                                       | 欠点                                                                                               |
| -------- | -------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| (a) 推奨 | us-east-1(WebACL と同居)                     | 同一リージョン要件があった場合でも確実に動く。一般的な構成 | Athena(ap-northeast-1)からのクエリがクロスリージョン読み取りになり、データ転送料とレイテンシが乗る |
| (b)      | ap-northeast-1(Athena と同居)                | E4 のクエリが速く安い                                      | S3 配信先に同一リージョン要件があった場合に `PutLoggingConfiguration` が失敗する(未確認)           |
| (c)      | us-east-1 に置き、Athena も us-east-1 に移す | 両立する                                                   | SPEC 2 の図から外れる。CoreStack の分割が必要                                                      |

**推奨**: (a)。E7(コスト測定)でクロスリージョン転送料を実測してレポートの材料にできる。デプロイ時に (b) が通るか試す価値もあるので、RUNBOOK に検証手順を書く。

**決定**: **(a) us-east-1(WebACL と同居)を採用**(2026-08-13、「管理コストの低い方」という指示による)。理由: バケットが WebACL と同じ WafEdgeStack に属するのでライフサイクル(作成・削除・権限)が 1 スタックに閉じ、teardown も単純になる。同一リージョン要件の有無が未確定でも確実に動く側であり、失敗時の切り分けコストが発生しない。クロスリージョン読み取りの転送料は E7 で実測してレポートに載せる。

---

## Q6. 【要確認】`Reporting-Endpoints` に相対パスを書いてよいか

**SPEC の記述** (4.2): `Reporting-Endpoints: csp-endpoint="/api/csp-report"`。

**懸念**: Reporting API の仕様上、エンドポイントの値は URL として定義されている。相対パスを与えたときの解釈は実装依存で、無視される可能性がある。無視されると `report-to` 経由の違反レポートが届かず、**E3 の集計がゼロ件になっているのに「違反が無かった」と誤読する**危険がある。

**絶対 URL にできない理由**: 絶対 URL にはディストリビューションのドメイン名が必要だが、ResponseHeadersPolicy はディストリビューションより先に作られるため、同一スタック内で循環参照になる。

**実装済みの方針**: SPEC どおり相対パスのまま実装し、後方互換の `report-uri /api/csp-report` を併記している(こちらは相対パスが正式に有効)。少なくとも `report-uri` 経由では届く。

**決めてほしいこと**: このままでよいか。E3 の手順に「`report-to` と `report-uri` のどちらで届いたかを切り分ける」ステップを入れる想定(レポートの「仕様の過渡期」の話題として使える)。

**決定**: (未回答 — Phase 5 の E3 実装までに決めればよい)

---

## Q7. 【要確認・Phase 2 に影響】Cognito App Client をどのスタックに置くか

**SPEC の記述** (2 / 4.1): CoreStack に「Cognito UserPool + App Client」。

**問題**: App Client の callback / logout URL には hardened / baseline 両ディストリビューションのドメインが必要(SPEC 4.1)。一方 DeliveryStack は CSP の `connect-src` / `form-action` のために Cognito のドメインを必要とする。両方を素直に実装すると **CoreStack ⇄ DeliveryStack の循環参照**になり `cdk deploy` が失敗する。

**代替案**:

| 案       | 内容                                                                                                | 備考                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| (a) 推奨 | UserPool と Managed Login ドメインは CoreStack、**App Client だけ DeliveryStack** に置く            | 循環が消える。カスタムリソース不要。SPEC の図とは配置が変わるだけで、クライアントの要件(public / PKCE / Auth Code のみ)は変わらない |
| (b)      | App Client は CoreStack に置き、DeliveryStack から `AwsCustomResource` で callback URL を後追い更新 | SPEC の図どおり。ただし `UpdateUserPoolClient` は全プロパティ上書きのため設定がずれやすく壊れやすい                                 |
| (c)      | CloudFront にカスタムドメインを付けてドメイン名を既知にする                                         | Route 53 + ACM が必要で SPEC の範囲外。コストも増える                                                                               |

**Phase 1 の実装状況**: UserPool と Managed Login ドメインのみ CoreStack に実装済み。**App Client は未実装**。

**決定**: **(a) 採用**(2026-08-13)。UserPool と Managed Login ドメインは CoreStack、App Client は DeliveryStack に置く。SPEC.md 2 章の図と 4.1 に反映済み。Phase 2 で実装する。

---

## Q8. cdk-nag は v2 を使う(v3 では granular な指摘を抑制できない)

**SPEC の記述** (1 / 4.8): 「抑制は理由付きで `NagSuppressions` に記述」。

**現状**(2026-08-13 実測): cdk-nag の最新は v3 で、`NagSuppressions` は**廃止**され `Validations.of(construct).acknowledge({ id, reason })` に置き換わっている(cdk-nag の `MIGRATION.md`)。しかし v3 の移行ガイドが示す granular finding の ID(例: `AwsSolutions-IAM5[Resource::arn:aws:logs:...]`)は `::` を含み、aws-cdk-lib 2.264 の `Validations.acknowledge` が `::` をプレフィックス区切りとして予約しているため **`InvalidValidationId` で拒否される**。結果、ワイルドカード権限のような granular な指摘を抑制する手段が無く `cdk synth` が通らない。

**実装済みの方針**: **cdk-nag を v2 系に固定**(現在 2.38.2)。SPEC の記述どおり `NagSuppressions` を使う。理由は `infra/bin/nag-suppressions.ts` の冒頭コメントにも記載。

**参考**: この過程で AWSLambdaBasicExecutionRole(AWS 管理ポリシー)の使用をやめ、CSP コレクタ専用ロググループにだけ書ける最小権限ロールに置き換えた。結果として `AwsSolutions-IAM4` の指摘自体が消えており、実質的にセキュリティ posture は改善している。

**決めてほしいこと**: v2 固定でよいか(v3 側の不具合が直れば移行できる)。

**決定**: **v3 に合わせる**(2026-08-13)。以下の対応で `cdk synth` が通ることを実測で確認した。SPEC.md 1 章 / 4.8 に反映済み。

1. 登録は `Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }))`。
2. 通常の指摘は `Validations.of(scope).acknowledge({ id, reason })`。
3. granular finding だけは `acknowledge()` の ID 検証(`::` をプレフィックス区切りとして予約)に弾かれるため、**公開定数 `Validations.ACKNOWLEDGED_RULES_METADATA_KEY` を使って `acknowledge()` と同じ形のメタデータを直接書き込む**(`infra/bin/nag-suppressions.ts` の `acknowledgeGranularFinding`)。上流で ID 検証が緩和されたら通常の `acknowledge()` に戻す。
4. finding ID には対象リソースの ARN 文字列がそのまま入る。`Stack.formatArn()` は認証情報の有無でアカウント / リージョンを具体値に解決してしまい **環境ごとに ID が変わる**ため、IAM ポリシー側は擬似パラメータ(`Aws.PARTITION` / `Aws.REGION` / `Aws.ACCOUNT_ID`)で ARN を組み立てている。ARN の組み立ては `cspCollectorLogStreamArn()` に集約し、ポリシー側と acknowledge 側でずれないようにした。

**検証**: `CDK_DEFAULT_ACCOUNT` の有無 × `namePrefix` / `phase` の組み合わせで `cdk synth` が通ること、抑制がテンプレートの `Metadata.cdk_nag` に出ること、抑制を外すと `cdk synth` が失敗することを確認済み。

---

## Q9. 【デプロイ時に要確認】Phase 2 で `cdk synth` では検証しきれない 3 点

`cdk deploy` は実行していないため(SPEC の指示)、以下は**実際のデプロイで初めて真偽が分かる**。失敗した場合の代替案も併記する。最初のデプロイ時に確認してほしい。

### (1) CloudFront の Origin Custom Header が Secrets Manager の動的参照を解決するか

CSP コレクタ API の直叩きを防ぐ共有シークレットは、CloudFront の Origin Custom Header と Lambda の環境変数の両方に同じ値が必要になる。値をコードに書かないため(SPEC 6)、両者とも `{{resolve:secretsmanager:<シークレット名>:SecretString:::}}` という **CloudFormation の動的参照**として渡している。

ARN ではなく**シークレット名**で参照しているのは意図的で、ARN を使うとクロススタック参照(`Fn::ImportValue`)が動的参照の文字列の中に入り込み、リテラルとして解釈されなくなるため。名前を固定することで両スタックが独立にリテラル文字列を組み立てられる(`infra/config/naming.ts` の `originSecretDynamicRef`)。

- Lambda の環境変数で動的参照が使えることは確実。
- **CloudFront の `OriginCustomHeaders` で使えるかは未確認。**

**確認方法**: デプロイ後に `curl -i https://<hardened>/api/csp-report -X POST -H 'content-type: application/csp-report' -d '{}'` で 204 が返ること。403 が返る場合はヘッダの値が解決されていない。

**失敗時の代替案**: `-c originSecret=<値>` で運用者が値を渡す方式に切り替える(両スタックが同じ context を読む)。`cdk deploy` のたびに渡す必要があるが、確実に動く。

### (2) WAF ログバケットのポリシー(ACL 条件を外している)

AWS のドキュメントが示すバケットポリシーには `s3:x-amz-acl: bucket-owner-full-control` の条件が含まれるが、**この条件は付けていない**。ACL 無効(BucketOwnerEnforced、現在の S3 の既定)のバケットでは配信側が ACL ヘッダを送らず、条件を付けると逆に拒否されうるため。

また、WAF の `PutLoggingConfiguration` はバケットポリシーを自動生成することがあるが、それは CDK 管理外の変更になり、次の `cdk deploy` でポリシーを更新すると消えてログが止まる。そのため**ポリシーを CDK 側で明示的に持たせている**。

**確認方法**: デプロイ後 5〜10 分でバケットに `AWSLogs/<account>/WAFLogs/us-east-1/edge-lab-edge/...` が現れること。現れなければ CloudTrail で `delivery.logs.amazonaws.com` の AccessDenied を確認する。

**失敗時の代替案**: バケットの `objectOwnership` を `BUCKET_OWNER_PREFERRED` にし、ポリシーに ACL 条件を戻す。

### (3) CloudFront の標準アクセスログ

CloudFront の標準ログ配信は配信先バケットの ACL を使うため、この 1 つだけ `BUCKET_OWNER_PREFERRED`(ACL 有効)にしている。他のバケットはすべて ACL 無効。

**確認方法**: デプロイ後にディストリビューションへ数回アクセスし、`CloudFrontAccessLogs` バケットに `HardenedDistribution/` `BaselineDistribution/` が現れること(反映まで最大 1 時間程度かかる)。

---

## Q10. 【情報】スタック間参照が `Fn::GetStackOutput` になる

`crossRegionReferences: true`(us-east-1 の WebACL を参照するために必須)を有効にすると、CDK は同一リージョンのスタック間参照も含めて `Fn::GetStackOutput` という**クラウドアセンブリ独自の形式**で出力する。これは `cdk` CLI がデプロイ時に解決するため、**合成済みテンプレートを `aws cloudformation deploy` に直接渡すことはできない**。

デプロイは必ず `cdk deploy` で行うこと(README に記載する)。スタックの依存順序(CoreStack / WafEdgeStack → DeliveryStack)は `cdk.out/manifest.json` に記録済みで、`cdk deploy --all` が正しい順に実行する。

---

## Q11. 【情報】E5 / E6 を k6 ではなく Node で実装している

**SPEC の記述** (4.7 の表): E5 は「k6。同時実行数と RPS を明示的に上限設定できること」、E6 は「Python or k6」。

**実装**: E5 / E6 は Node で実装した(E7 は SPEC どおり k6)。

**理由**: E5 / E6 で測りたいのはスループットではなく **「何回目のリクエストでブロックされたか」という逐次の回数** と **回復までの時間**。外部プロセスに投げると、SPEC 4.7 が要求する安全弁(対象ホストのホワイトリスト、既定 RPS の低い固定値、総試行回数の上限)を呼び出し側で強制しきれない。Node で実装すると `experiments/lib/targets.mjs` の `assertAllowedTarget` を必ず通す作りにでき、上限もプロセス内で保証できる。

SPEC が要求している性質(同時実行数と RPS を明示的に上限設定できること)は満たしている。むしろ既定値を超える指定を **拒否する** ところまで実装している。

負荷とレイテンシのパーセンタイル測定(E7)は k6 の得意分野なので SPEC どおり k6 を使っている。

**決めてほしいこと**: この方針でよいか(k6 に統一したい理由があれば教えてほしい)。

**決定**: (未回答)
