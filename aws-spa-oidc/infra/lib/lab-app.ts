/**
 * CDK アプリの組み立て。
 *
 * `bin/app.ts`(cdk CLI から実行)と `test/`(cdk-nag 検証の回帰テスト)の
 * 両方から使う。片方だけ通って片方が落ちる、という食い違いを作らないため、
 * スタックの構成と cdk-nag の登録はここに一本化する。
 */

import * as cdk from "aws-cdk-lib";
import * as cdkNag from "cdk-nag";
import { applyLabSuppressions } from "../bin/nag-suppressions.ts";
import { resolveContext } from "../config/context.ts";
import { EDGE_REGION } from "../config/naming.ts";
import { CoreStack } from "./core-stack.ts";
import { DeliveryStack } from "./delivery-stack.ts";
import { WafCognitoStack } from "./waf-cognito-stack.ts";
import { WafEdgeStack } from "./waf-edge-stack.ts";

/** SPEC 2 のアーキテクチャ図どおり、WAF 以外は ap-northeast-1 に置く */
export const PRIMARY_REGION = "ap-northeast-1";

export interface LabAppOptions {
  /** cdk CLI 以外(テストなど)から使うときの context */
  readonly context?: Record<string, unknown>;
  /** テストで cdk.out を汚さないための出力先 */
  readonly outdir?: string;
  /** 未指定なら CDK_DEFAULT_ACCOUNT(= cdk CLI が解決した値) */
  readonly account?: string;
  /**
   * cdk-nag を登録するか(既定 true)。テンプレートの内容だけを検証するテストは
   * 検証プラグインを走らせる必要がなく、無効にすると大幅に速くなる。
   */
  readonly withNag?: boolean;
}

export interface LabApp {
  readonly app: cdk.App;
  readonly coreStack: CoreStack;
  readonly wafEdgeStack: WafEdgeStack;
  readonly wafCognitoStack: WafCognitoStack;
  readonly deliveryStack: DeliveryStack;
}

export function createLabApp(options: LabAppOptions = {}): LabApp {
  const app = new cdk.App({ context: options.context, outdir: options.outdir });
  const labContext = resolveContext(app.node);

  // アカウント ID はコードにも cdk.context.json にも書かない(SPEC 6)。
  // cdk CLI が解決した値を環境変数から受け取る。
  const env: cdk.Environment = {
    account: options.account ?? process.env.CDK_DEFAULT_ACCOUNT,
    region: PRIMARY_REGION,
  };

  const coreStack = new CoreStack(app, "CoreStack", {
    env,
    stackName: `${labContext.namePrefix}-core`,
    description:
      "Edge defense lab: S3 origin, Cognito, CSP report collector, WAF log analysis (SPEC 4.1)",
    labContext,
  });

  // CLOUDFRONT スコープの WebACL は us-east-1 にしか作れないため別スタックにする
  const wafEdgeStack = new WafEdgeStack(app, "WafEdgeStack", {
    env: { account: env.account, region: EDGE_REGION },
    stackName: `${labContext.namePrefix}-waf-edge`,
    description: "Edge defense lab: CLOUDFRONT-scope web ACL and its log bucket (SPEC 4.4)",
    // リージョンをまたいで WebACL の ARN を渡すために必要
    crossRegionReferences: true,
    labContext,
  });

  // Managed Login は CloudFront を経由しないため、エッジ WAF では守れない。
  // ユーザープールに直接 WebACL を関連付ける(SPEC 4.5)。
  const wafCognitoStack = new WafCognitoStack(app, "WafCognitoStack", {
    env,
    stackName: `${labContext.namePrefix}-waf-cognito`,
    description:
      "Edge defense lab: COGNITO_USER_POOL-scope web ACL for the managed login endpoints (SPEC 4.5)",
    labContext,
    userPoolArn: coreStack.userPool.userPoolArn,
  });

  const deliveryStack = new DeliveryStack(app, "DeliveryStack", {
    env,
    stackName: `${labContext.namePrefix}-delivery`,
    description:
      "Edge defense lab: hardened / baseline CloudFront distributions and the Cognito app client (SPEC 4.2)",
    crossRegionReferences: true,
    labContext,
    siteBucketName: coreStack.siteBucket.bucketName,
    userPool: coreStack.userPool,
    userPoolDomainPrefix: coreStack.userPoolDomain.domainName,
    cspApi: coreStack.cspApi,
    edgeWebAclArn: wafEdgeStack.webAclArn,
  });
  // Origin Custom Header はシークレット名による動的参照で解決するので
  // CloudFormation からは依存関係が見えない。明示的に順序を付ける。
  deliveryStack.addStackDependency(coreStack);

  cdk.Tags.of(app).add("project", "edge-defense-lab");
  cdk.Tags.of(app).add("labPhase", labContext.phase);

  // 「静的に検査した」こと自体を成果物にする(SPEC 1)。
  // cdk-nag v3 は CDK ネイティブの Policy Validation プラグインとして登録し、
  // 結果は cdk.out/validation-report.json に出る。抑制(acknowledge)は
  // 理由必須で bin/nag-suppressions.ts に集約する。
  if (options.withNag !== false) {
    cdk.Validations.of(app).addPlugins(
      new cdkNag.AwsSolutionsChecks(app, {
        verbose: true,
        // 何をなぜ許容したかをテンプレートの Metadata にも残し、
        // cdk.out を持たない相手にも証跡を渡せるようにする
        writeSuppressionsToCloudFormation: true,
      }),
    );
    applyLabSuppressions({ coreStack, wafEdgeStack, wafCognitoStack, deliveryStack });
  }

  return { app, coreStack, wafEdgeStack, wafCognitoStack, deliveryStack };
}
