/**
 * WafCognitoStack(SPEC 4.5)— ap-northeast-1、scope=COGNITO_USER_POOL。
 *
 * **なぜエッジ WAF とは別に必要なのか**:
 * Managed Login でのログインは CloudFront を経由せず Cognito のドメインへ直接行く。
 * つまりエッジの WebACL はログイン試行を一切見られない。ユーザープールに WebACL を
 * 直接関連付けて初めてログイン試行を保護・観測できる。
 *
 * **ATP(`AWSManagedRulesATPRuleSet`)は使えない**: ATP / ACFP を含む WebACL は
 * Cognito ユーザープールに関連付けできない(AWS の現行仕様)。
 * 経緯は docs/OPEN_QUESTIONS.md Q1、判断は docs/DECISIONS.md の ADR に記録する。
 *
 * **検査できる範囲の制約**: Managed Login へのリクエストは body が WAF に転送されず、
 * ユーザー名・パスワード等の PII にはマッチできない。したがってルールは
 * IP 単位のレートベースのみで組み、E6 は「ブロック開始までの試行回数」と
 * 「回復までの時間」を測る設計にしている。
 */

import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";
import type { LabContext } from "../config/context.ts";
import { cognitoWafLogBucketName, cognitoWebAclName } from "../config/naming.ts";
import {
  BLOCK_RESPONSE,
  COGNITO_RATE_RULE,
  RATE_LIMIT_WINDOW_SECONDS,
  REDACTED_LOG_HEADERS,
} from "../config/waf-rules.ts";

export interface WafCognitoStackProps extends cdk.StackProps {
  readonly labContext: LabContext;
  /** 関連付け先のユーザープール ARN(CoreStack から) */
  readonly userPoolArn: string;
}

export class WafCognitoStack extends cdk.Stack {
  public readonly webAcl: wafv2.CfnWebACL;
  public readonly logBucket: s3.Bucket;

  public constructor(scope: Construct, id: string, props: WafCognitoStackProps) {
    super(scope, id, props);

    const { labContext } = props;
    const webAclName = cognitoWebAclName(labContext.namePrefix);

    this.webAcl = new wafv2.CfnWebACL(this, "CognitoWebAcl", {
      name: webAclName,
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      description: "Edge defense lab Cognito user pool scope web ACL - SPEC 4.5",
      customResponseBodies: {
        [BLOCK_RESPONSE.bodyKey]: {
          content: BLOCK_RESPONSE.body,
          contentType: "APPLICATION_JSON",
        },
      },
      rules: [
        {
          name: COGNITO_RATE_RULE.name,
          priority: COGNITO_RATE_RULE.priority,
          statement: {
            rateBasedStatement: {
              limit: labContext.rateLimitCognito,
              aggregateKeyType: "IP",
              evaluationWindowSec: RATE_LIMIT_WINDOW_SECONDS,
            },
          },
          // CAPTCHA は使わない。Managed Login の TOTP 登録と干渉して
          // 回復不能なエラーになる既知の問題があるため(SPEC 4.5 の調査結果)。
          //
          // なおカスタムレスポンスが返るのは Managed Login では「最初の 1 回」だけで、
          // 2 回目以降はステータスコードとヘッダのみが反映される。E6 の判定は
          // 本文ではなくステータスコードと識別ヘッダで行うこと。
          action: {
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
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: COGNITO_RATE_RULE.name,
          },
        },
      ],
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: webAclName,
      },
    });

    new wafv2.CfnWebACLAssociation(this, "UserPoolAssociation", {
      resourceArn: props.userPoolArn,
      webAclArn: this.webAcl.attrArn,
    });

    this.logBucket = this.createLogBucket(labContext.namePrefix);
    this.enableLogging(this.logBucket);

    new cdk.CfnOutput(this, "CognitoWebAclArn", { value: this.webAcl.attrArn });
    new cdk.CfnOutput(this, "CognitoWafLogBucketName", {
      value: this.logBucket.bucketName,
    });
  }

  /**
   * バケット名は CoreStack の Glue テーブル(cognito_waf_logs)と一致させる必要が
   * あるため config/naming.ts から取る。
   */
  private createLogBucket(namePrefix: string): s3.Bucket {
    const bucket = new s3.Bucket(this, "CognitoWafLogBucket", {
      // WAF の配信先は `aws-waf-logs-` 始まりであることが必須
      bucketName: cognitoWafLogBucketName(namePrefix, this.account, this.region),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // WafEdgeStack と同じ理由で、配信許可を CDK 側に明示的に持たせる
    // (WAF が自動で付けたポリシーは再デプロイで消えてログが止まる)。
    for (const statement of [
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
    ]) {
      bucket.addToResourcePolicy(statement);
    }

    return bucket;
  }

  private enableLogging(bucket: s3.Bucket): void {
    const logging = new wafv2.CfnLoggingConfiguration(this, "CognitoWafLogging", {
      resourceArn: this.webAcl.attrArn,
      logDestinationConfigs: [bucket.bucketArn],
      // CloudFormation は WAF API そのままの形(先頭大文字)を期待する
      redactedFields: REDACTED_LOG_HEADERS.map((name) => ({
        singleHeader: { Name: name },
      })),
    });

    const bucketPolicy = bucket.policy?.node.defaultChild;
    if (bucketPolicy !== undefined) {
      logging.node.addDependency(bucketPolicy);
    }
  }
}
