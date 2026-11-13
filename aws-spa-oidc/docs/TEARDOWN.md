# 後片付け(課金を止める手順)

**WAF の固定費だけで月 $19 かかる**([COST.md](COST.md))。使わない期間は消すこと。

## 1. まず結果を退避する

`experiments/results/` はリポジトリにコミットする前提だが、未コミットのものが
無いか確認する。スタックを消すと CloudWatch Logs と WAF ログも消える。

```bash
git status --short experiments/results/
```

集計し直す可能性がある生ログ(CSP コレクタの CloudWatch Logs、WAF の S3 ログ)は、
必要なら先に手元へ落とす。

```bash
# WAF ログを手元へ(必要な場合のみ。量が多いことがある)
aws s3 sync "s3://$(jq -r '.[] | select(.EdgeWafLogBucketName) | .EdgeWafLogBucketName' infra/cdk-outputs.json)/" ./waf-logs-backup/
```

## 2. 全スタックを削除する

```bash
cd infra
npx cdk destroy --all
```

削除順は CDK が依存関係から解決する(DeliveryStack → CoreStack / WafEdgeStack)。

S3 バケット、Cognito ユーザープール、CloudWatch ロググループはすべて
`RemovalPolicy.DESTROY` かつ `autoDeleteObjects: true` で作ってあるので、
**中身ごと消える**。実験結果を残したい場合は手順 1 を先に済ませること。

## 3. 消え残りを確認する

CDK の管理外に出たリソースが無いか確認する。特に **WAF が自動で追加した
バケットポリシー**や、Cognito ユーザープールに残った WebACL の関連付け。

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# スタックが残っていないこと(2 リージョン)
aws cloudformation list-stacks --region ap-northeast-1 \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE DELETE_FAILED \
  --query "StackSummaries[?contains(StackName, 'edge-lab')].[StackName,StackStatus]" --output table
aws cloudformation list-stacks --region us-east-1 \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE DELETE_FAILED \
  --query "StackSummaries[?contains(StackName, 'edge-lab')].[StackName,StackStatus]" --output table

# WebACL が残っていないこと
aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1 --output table
aws wafv2 list-web-acls --scope REGIONAL --region ap-northeast-1 --output table

# ログバケットが残っていないこと
aws s3 ls | grep -E "aws-waf-logs-|edge-lab" || echo "なし"

# Secrets Manager(削除待機期間があるので「削除予定」で残る)
aws secretsmanager list-secrets --region ap-northeast-1 \
  --query "SecretList[?contains(Name, 'edge-lab')].[Name,DeletedDate]" --output table
```

## 4. 削除に失敗しやすいところ

| 症状                                                                         | 原因                                                                  | 対処                                                                               |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `DELETE_FAILED` で S3 バケットが残る                                         | 削除中に新しいログが書き込まれた                                      | WAF のロギング設定が消えたことを確認してから、バケットを空にして再度 `cdk destroy` |
| WebACL が削除できない                                                        | 関連付けが残っている                                                  | `aws wafv2 disassociate-web-acl` で外してから再実行                                |
| CloudFront の削除が遅い                                                      | ディストリビューションの無効化に時間がかかる                          | 15〜20 分ほど待つ。CDK が待機する                                                  |
| Secrets Manager が消えない                                                   | 既定の削除待機期間(7〜30 日)がある                                    | 待つか `aws secretsmanager delete-secret --force-delete-without-recovery`          |
| Lambda の削除が `Secrets Manager can't find the specified secret` で失敗する | シークレットが先に削除され、Lambda の環境変数の動的参照が解決できない | 下記 4.1                                                                           |

### 4.1 Lambda の削除がシークレット不在で失敗した場合

Lambda の環境変数にはシークレット名による動的参照が入っている。削除時に
シークレットが先に消えると、この参照が解決できず Lambda の削除が失敗する。

**シークレットを復元して `cdk destroy` を再実行しても直らないことがある。**
`collector.node.addDependency(originSecret)` を入れる前のテンプレートには
依存関係が無いため、再実行しても同じ順序でシークレットが先に消えるため。

確実なのは、**失敗した Lambda だけ残してスタックを消し、あとで単体で削除する**方法。
`--retain-resources` は `DELETE_FAILED` 状態のときだけ使える。

```bash
# 1) 失敗した Lambda だけ残してスタックを削除
aws cloudformation delete-stack --region ap-northeast-1 \
  --stack-name edge-lab-core --retain-resources CspCollector51B9B380
aws cloudformation wait stack-delete-complete --region ap-northeast-1 \
  --stack-name edge-lab-core

# 2) 取り残した Lambda を手で削除
aws lambda list-functions --region ap-northeast-1 \
  --query "Functions[?contains(FunctionName,'CspCollector')].FunctionName" --output text
aws lambda delete-function --region ap-northeast-1 --function-name <上で出た関数名>

# 3) シークレットを完全削除(削除予定のままだと課金が続く)
aws secretsmanager delete-secret --region ap-northeast-1 \
  --secret-id edge-lab/cloudfront-origin-secret --force-delete-without-recovery
```

> 論理 ID(`CspCollector51B9B380`)はエラーメッセージに出るものを使うこと。
>
> この失敗は `collector.node.addDependency(originSecret)` を入れて解消済み
> (DECISIONS.md ADR-007)。**修正前にデプロイしたスタックにだけ起きる。**
> 修正後にデプロイし直したスタックは `cdk destroy --all` だけで消える。

## 5. 一時的に費用を下げるだけなら

全部消さずに固定費を減らす選択肢。

| やること                                | 減る額                                          | 失うもの                                     |
| --------------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| `-c baselineEnabled=false` で再デプロイ | CloudFront 1 本分の変動費のみ(固定費は減らない) | hardened / baseline の同時比較(実験の主目的) |
| WafCognitoStack だけ削除                | WebACL $5 + ルール $1 = $6 / 月                 | E6 が実行できなくなる                        |
| WAF ログバケットの中身を削除            | S3 保管料                                       | E4 の再集計ができなくなる                    |

**WAF の WebACL とルールの固定費は、スタックを消す以外に減らせない。**
中途半端に残すより全削除して、必要なときに `cdk deploy --all` し直すのが安く確実。
