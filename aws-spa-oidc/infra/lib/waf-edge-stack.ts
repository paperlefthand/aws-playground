/**
 * WafEdgeStack(SPEC 4.4)— **us-east-1 必須**。
 *
 * CLOUDFRONT スコープの WebACL は us-east-1 にしか作れないため、他リソースと
 * 同一スタックにはできない。DeliveryStack からは `crossRegionReferences: true`
 * で ARN を参照する。
 *
 * ルール構成は config/waf-rules.ts が単一情報源。ルール名はそのまま CloudWatch
 * メトリクス名になり、Athena の `terminatingruleid` とも一致する。
 */

import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";
import type { LabContext } from "../config/context.ts";
import { edgeWafLogBucketName, edgeWebAclName } from "../config/naming.ts";
import {
  BLOCK_RESPONSE,
  EDGE_MANAGED_RULE_GROUPS,
  GEO_MATCH_RULE,
  RATE_LIMIT_WINDOW_SECONDS,
  RATE_RULE_ALL,
  RATE_RULE_API,
  REDACTED_LOG_HEADERS,
} from "../config/waf-rules.ts";

export interface WafEdgeStackProps extends cdk.StackProps {
  readonly labContext: LabContext;
}

export class WafEdgeStack extends cdk.Stack {
  public readonly webAcl: wafv2.CfnWebACL;
  /** DeliveryStack の Distribution に渡す ARN(クロスリージョン参照) */
  public readonly webAclArn: string;
  public readonly logBucket: s3.Bucket;

  public constructor(scope: Construct, id: string, props: WafEdgeStackProps) {
    super(scope, id, props);

    const { labContext } = props;
    const webAclName = edgeWebAclName(labContext.namePrefix);

    this.webAcl = new wafv2.CfnWebACL(this, "EdgeWebAcl", {
      name: webAclName,
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      description: "Edge defense lab CLOUDFRONT-scope web ACL - SPEC 4.4",
      // ブロックが計測可能であることを保証するためのカスタムレスポンス。
      // 403 + JSON + 識別ヘッダで「WAF による 403」を切り分けられるようにする。
      customResponseBodies: {
        [BLOCK_RESPONSE.bodyKey]: {
          content: BLOCK_RESPONSE.body,
          contentType: "APPLICATION_JSON",
        },
      },
      rules: buildEdgeRules(labContext),
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: webAclName,
      },
    });
    this.webAclArn = this.webAcl.attrArn;

    this.logBucket = this.createLogBucket(labContext.namePrefix);
    this.enableLogging(this.logBucket);

    new cdk.CfnOutput(this, "EdgeWebAclArn", { value: this.webAclArn });
    new cdk.CfnOutput(this, "EdgeWafLogBucketName", {
      value: this.logBucket.bucketName,
    });
  }

  /**
   * WAF ログの配信先。WebACL と同じ us-east-1 に置く(OPEN_QUESTIONS Q5 の決定)。
   * バケット名は CoreStack の Glue テーブルと一致させる必要があるため
   * config/naming.ts から取る。
   */
  private createLogBucket(namePrefix: string): s3.Bucket {
    const bucket = new s3.Bucket(this, "EdgeWafLogBucket", {
      // WAF の配信先は `aws-waf-logs-` 始まりであることが必須
      bucketName: edgeWafLogBucketName(namePrefix, this.account),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ログ配信の許可は WAF の PutLoggingConfiguration が自動で付けることもあるが、
    // その場合 CDK 管理外の変更になり、次の `cdk deploy` でバケットポリシーを
    // 更新した際に消えてログが止まる。ここで明示的に持たせて再デプロイに耐えさせる。
    //
    // `s3:x-amz-acl` 条件は付けない。ACL 無効(BucketOwnerEnforced)のバケットでは
    // 配信側が ACL ヘッダを送らないため、条件を付けると逆に拒否されうる。
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AWSLogDeliveryWrite",
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("delivery.logs.amazonaws.com")],
        actions: ["s3:PutObject"],
        resources: [bucket.arnForObjects(`AWSLogs/${this.account}/*`)],
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: {
            "aws:SourceArn": `arn:${this.partition}:logs:${this.region}:${this.account}:*`,
          },
        },
      }),
    );
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AWSLogDeliveryAclCheck",
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("delivery.logs.amazonaws.com")],
        actions: ["s3:GetBucketAcl", "s3:ListBucket"],
        resources: [bucket.bucketArn],
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: {
            "aws:SourceArn": `arn:${this.partition}:logs:${this.region}:${this.account}:*`,
          },
        },
      }),
    );

    return bucket;
  }

  private enableLogging(bucket: s3.Bucket): void {
    const logging = new wafv2.CfnLoggingConfiguration(this, "EdgeWafLogging", {
      resourceArn: this.webAcl.attrArn,
      logDestinationConfigs: [bucket.bucketArn],
      // 認証情報を Athena のクエリ結果に残さない(SPEC 4.4)。
      // CloudFormation は WAF API そのままの形(先頭大文字)を期待する。
      redactedFields: REDACTED_LOG_HEADERS.map((name) => ({
        singleHeader: { Name: name },
      })),
    });

    // バケットポリシーが先に無いと PutLoggingConfiguration が失敗する
    const bucketPolicy = bucket.policy?.node.defaultChild;
    if (bucketPolicy !== undefined) {
      logging.node.addDependency(bucketPolicy);
    }
  }
}

function buildEdgeRules(labContext: LabContext): wafv2.CfnWebACL.RuleProperty[] {
  const blockAction: wafv2.CfnWebACL.RuleActionProperty = {
    block: {
      customResponse: {
        responseCode: BLOCK_RESPONSE.statusCode,
        customResponseBodyKey: BLOCK_RESPONSE.bodyKey,
        responseHeaders: [
          {
            name: BLOCK_RESPONSE.markerHeaderName,
            value: BLOCK_RESPONSE.markerHeaderValue,
          },
        ],
      },
    },
  };

  const managedRules = EDGE_MANAGED_RULE_GROUPS.map((spec) => ({
    name: spec.name,
    priority: spec.priority,
    statement: {
      managedRuleGroupStatement: {
        vendorName: spec.vendorName,
        name: spec.managedRuleGroupName,
        ruleActionOverrides:
          spec.excludedRules.length > 0
            ? spec.excludedRules.map((ruleName) => ({
                name: ruleName,
                actionToUse: { count: {} },
              }))
            : undefined,
      },
    },
    // alwaysCount のルールグループは wafAction によらず Count のまま。
    // count オーバーライドはグループ内の全ルールを Count 扱いにする。
    overrideAction:
      spec.alwaysCount || labContext.wafAction === "count" ? { count: {} } : { none: {} },
    visibilityConfig: {
      sampledRequestsEnabled: true,
      cloudWatchMetricsEnabled: true,
      metricName: spec.name,
    },
  }));

  const rateRules: wafv2.CfnWebACL.RuleProperty[] = [
    {
      name: RATE_RULE_ALL.name,
      priority: RATE_RULE_ALL.priority,
      statement: {
        rateBasedStatement: {
          limit: labContext.rateLimitAll,
          aggregateKeyType: "IP",
          evaluationWindowSec: RATE_LIMIT_WINDOW_SECONDS,
        },
      },
      action: blockAction,
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: RATE_RULE_ALL.name,
      },
    },
    {
      name: RATE_RULE_API.name,
      priority: RATE_RULE_API.priority,
      statement: {
        rateBasedStatement: {
          limit: labContext.rateLimitApi,
          aggregateKeyType: "IP",
          evaluationWindowSec: RATE_LIMIT_WINDOW_SECONDS,
          // CSP レポート API だけ閾値を下げる(SPEC 4.4 優先度 110)
          scopeDownStatement: {
            byteMatchStatement: {
              fieldToMatch: { uriPath: {} },
              positionalConstraint: "STARTS_WITH",
              searchString: RATE_RULE_API.pathPrefix,
              textTransformations: [{ priority: 0, type: "NONE" }],
            },
          },
        },
      },
      action: blockAction,
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: RATE_RULE_API.name,
      },
    },
  ];

  const geoRule: wafv2.CfnWebACL.RuleProperty = {
    name: GEO_MATCH_RULE.name,
    priority: GEO_MATCH_RULE.priority,
    // 「想定国以外からのアクセス」をそのままメトリクスにする。可視化専用で
    // ブロックはしないため、GeoMatch の誤判定がユーザーに影響しない。
    statement: {
      notStatement: {
        statement: {
          geoMatchStatement: { countryCodes: [...GEO_MATCH_RULE.countryCodes] },
        },
      },
    },
    action: { count: {} },
    visibilityConfig: {
      sampledRequestsEnabled: true,
      cloudWatchMetricsEnabled: true,
      metricName: GEO_MATCH_RULE.name,
    },
  };

  return [...managedRules, ...rateRules, geoRule];
}
