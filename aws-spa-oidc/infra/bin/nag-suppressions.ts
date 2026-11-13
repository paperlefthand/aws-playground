/**
 * cdk-nag(AwsSolutions ルールパック)の acknowledge。
 * **理由なしの抑制を作らないこと**(SPEC 4.8)。
 *
 * cdk-nag v3 は IAspect から CDK ネイティブの Policy Validation プラグインに
 * 変わり、v2 の `NagSuppressions` は `Validations.of(scope).acknowledge()` に
 * 置き換わった。
 *
 * ここに並ぶのは **実際に検出された指摘だけ**。将来の変更で新しい指摘が出れば
 * `cdk synth` が失敗するので、抑制を増やす前に必ず内容を読むこと。
 */

// aws-cdk-lib は CommonJS なので名前空間インポートで受ける
import * as cdk from "aws-cdk-lib";
import type { IConstruct } from "constructs";
import { type CoreStack, cspCollectorLogStreamArn } from "../lib/core-stack.ts";
import type { DeliveryStack } from "../lib/delivery-stack.ts";
import type { WafCognitoStack } from "../lib/waf-cognito-stack.ts";
import type { WafEdgeStack } from "../lib/waf-edge-stack.ts";

const { Validations } = cdk;

export interface LabStacks {
  readonly coreStack: CoreStack;
  readonly wafEdgeStack: WafEdgeStack;
  readonly wafCognitoStack: WafCognitoStack;
  readonly deliveryStack: DeliveryStack;
}

export function applyLabSuppressions(stacks: LabStacks): void {
  applyCoreStackSuppressions(stacks.coreStack);
  applyWafEdgeStackSuppressions(stacks.wafEdgeStack);
  applyWafCognitoStackSuppressions(stacks.wafCognitoStack);
  applyDeliveryStackSuppressions(stacks.deliveryStack);
}

function applyWafEdgeStackSuppressions(stack: WafEdgeStack): void {
  Validations.of(stack.logBucket).acknowledge({
    id: "AwsSolutions-S1",
    reason:
      "WAF ログの配信先バケット。S3 サーバアクセスログの配信先は同一リージョンにある必要があるが、分析基盤(CoreStack のアクセスログバケット)は ap-northeast-1 にありこのバケットは us-east-1 にある。誰がいつ読んだかは CloudTrail のデータイベントで追える。",
  });
}

function applyWafCognitoStackSuppressions(stack: WafCognitoStack): void {
  Validations.of(stack.logBucket).acknowledge({
    id: "AwsSolutions-S1",
    reason:
      "WAF ログの配信先バケット。ログの配信先にさらにサーバアクセスログを付けるとログがログを生む循環になるため無効。誰がいつ読んだかは CloudTrail のデータイベントで追える。",
  });
}

function applyDeliveryStackSuppressions(stack: DeliveryStack): void {
  const distributions = [stack.hardenedDistribution, stack.baselineDistribution].filter(
    (distribution) => distribution !== undefined,
  );
  for (const distribution of distributions) {
    Validations.of(distribution).acknowledge({
      id: "AwsSolutions-CFR4",
      reason:
        "カスタムドメインを持たず CloudFront の既定証明書を使うため、MinimumProtocolVersion に何を指定してもこの指摘は消えない(既定証明書は SNI 非対応クライアント向けに TLSv1 を残すため)。ACM 証明書と独自ドメインの導入は SPEC の範囲外。",
    });

    Validations.of(distribution).acknowledge({
      id: "Annotation::@aws-cdk/aws-cloudfront:minimumProtocolVersionWithoutCertificate",
      reason:
        "上と同じ理由。既定証明書のため minimumProtocolVersion の指定は効かない。将来カスタムドメインを付けたときに効くよう指定自体は残す。",
    });

    // GeoMatch ルール(SPEC 4.4 優先度 200)は Count のみで、国別の可視化が目的。
    Validations.of(distribution).acknowledge({
      id: "AwsSolutions-CFR1",
      reason:
        "地域制限は掛けない。どの国からのアクセスがどう扱われたかを測るのが実験 E4 の目的であり、CloudFront 側で先に落とすと WAF のメトリクスに現れなくなる。",
    });

    // OAC 用のバケットポリシーは CoreStack 側で明示的に持たせている。
    // ここでバケットを名前でインポートしているのは循環参照を避けるため。
    Validations.of(distribution).acknowledge({
      id: "Annotation::@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicyOac",
      reason:
        "意図的にバケットを名前でインポートしている。OAC からの読み取り許可は CoreStack のバケットポリシーに定義済みで、CDK に自動追記させるとスタック間で循環参照になる(lib/delivery-stack.ts の DeliveryStackProps 参照)。",
    });
  }

  // baseline に WAF が付いていないのは指摘どおりだが、それが実験の対照条件そのもの。
  if (stack.baselineDistribution) {
    Validations.of(stack.baselineDistribution).acknowledge({
      id: "AwsSolutions-CFR2",
      reason:
        "baseline ディストリビューションは「防御なし」の対照群として WebACL を付けない(SPEC 2.1)。hardened 側には WebACL を関連付けており、両者の差分を測ることが本ラボの目的。",
    });
  }

  Validations.of(stack.accessLogBucket).acknowledge({
    id: "AwsSolutions-S1",
    reason:
      "CloudFront アクセスログの配信先バケット。ログの配信先にさらにアクセスログを付けるとログがログを生む循環になるため無効。30 日で失効させている。",
  });
}

function applyCoreStackSuppressions(stack: CoreStack): void {
  Validations.of(stack.userPool).acknowledge({
    id: "AwsSolutions-COG2",
    reason:
      "MFA は SPEC 4.1 の指定どおり optional。実験 E6(ログイン試行のレート制限測定)で MFA チャレンジが介在しない条件を作るため必須にしない。本番構成では required にすべき。",
  });

  Validations.of(stack.userPool).acknowledge({
    id: "AwsSolutions-COG8",
    reason:
      "Plus 機能プラン(Cognito 脅威保護)は追加課金対象。本ラボの測定対象は WAF による防御であり、Cognito ネイティブの防御を混ぜると効果を切り分けられなくなるため Essentials に留める(docs/OPEN_QUESTIONS.md Q1 / Q2)。",
  });

  Validations.of(stack.cspApi).acknowledge({
    id: "AwsSolutions-APIG4",
    reason:
      "CSP 違反レポートはブラウザが認証情報を付けずに送るため、API 側で認可を要求すると本来集めたい違反が集まらない。代わりに CloudFront の Origin Custom Header 検証(Lambda 側で定数時間比較)とスロットリングで保護する(SPEC 4.1)。",
  });

  Validations.of(stack.cspCollector).acknowledge({
    id: "AwsSolutions-L1",
    reason:
      "Lambda ランタイムは nodejs22.x に固定している(docs/OPEN_QUESTIONS.md Q3 の決定)。測定期間中にランタイムが変わると結果の再現性が損なわれるため、最新版へ自動追随させない。",
  });

  Validations.of(stack.originSecret).acknowledge({
    id: "AwsSolutions-SMG4",
    reason:
      "この値は CloudFront の Origin Custom Header と Lambda の期待値の両方に同時反映する必要があり、自動ローテーションでは両者がずれて CSP レポートの取りこぼしが起きる。更新は再デプロイで行う。",
  });

  // ロググループの論理 ID は construct のパスから決まるため、直書きせず算出する
  const logGroupLogicalId = stack.getLogicalId(
    stack.cspCollectorLogs.node.defaultChild as cdk.CfnResource,
  );
  // cdk-nag は解決できないトークンを `<AWS::Partition>` のような文字列で出力する
  const findingArn = cspCollectorLogStreamArn({
    partition: "<AWS::Partition>",
    region: "<AWS::Region>",
    account: "<AWS::AccountId>",
    logGroupName: `<${logGroupLogicalId}>`,
  });
  acknowledgeGranularFinding(
    stack.cspCollectorRole,
    `AwsSolutions-IAM5[Resource::${findingArn}]`,
    "Lambda はリクエストごとに新しいログストリームを作るため、ストリーム名をワイルドカード以外で特定できない。権限はこの関数専用ロググループ配下の logs:CreateLogStream / PutLogEvents に限定済み。",
  );
}

/**
 * granular finding(`AwsSolutions-IAM5[Resource::<arn>]` のようにルール ID に
 * finding 名が埋め込まれる形式)の acknowledge。
 *
 * `Validations.acknowledge()` は ID を `::` で分割して「プレフィックス::ルール名」
 * として解釈し、`::` が 2 つ以上あると `InvalidValidationId` で落ちる。
 * granular finding の ID は `Resource::` / `Action::` / `Policy::` を含むため、
 * 公開 API 経由では常に拒否される(cdk-nag 3.0.2 / aws-cdk-lib 2.264.0)。
 *
 * `Validations.acknowledge()` の実体は「メタデータへの記録」なので、公開されている
 * `Validations.ACKNOWLEDGED_RULES_METADATA_KEY` を使って同じ形で直接書き込む。
 * 上流で ID の検証が緩和されたら通常の `acknowledge()` に戻すこと。
 * (docs/OPEN_QUESTIONS.md Q8)
 */
function acknowledgeGranularFinding(scope: IConstruct, ruleId: string, reason: string): void {
  scope.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, {
    [ruleId]: reason,
  });
}
