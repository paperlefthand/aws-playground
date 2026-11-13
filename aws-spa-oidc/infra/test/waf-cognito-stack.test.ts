import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { BLOCK_RESPONSE, COGNITO_RATE_RULE } from "../config/waf-rules.ts";
import { TEST_ACCOUNT, TEST_REGION, createLabStacks } from "./helpers.ts";

interface WebAclRule {
  Name: string;
  Priority: number;
  Action?: Record<string, unknown>;
  Statement: { RateBasedStatement?: { Limit: number; AggregateKeyType: string } };
}

function synth(context: Record<string, unknown> = {}): Template {
  return Template.fromStack(createLabStacks(context).wafCognitoStack);
}

function rulesOf(template: Template): WebAclRule[] {
  const acls = Object.values(template.findResources("AWS::WAFv2::WebACL")) as {
    Properties: { Rules: WebAclRule[] };
  }[];
  return acls[0].Properties.Rules;
}

describe("WafCognitoStack", () => {
  let template: Template;

  beforeAll(() => {
    template = synth();
  });

  // SPEC 4.5: Managed Login は CloudFront を経由しないのでエッジ WAF では守れない
  it("REGIONAL スコープの WebACL をユーザープールに関連付ける", () => {
    template.hasResourceProperties("AWS::WAFv2::WebACL", {
      Scope: "REGIONAL",
      DefaultAction: { Allow: {} },
    });
    template.resourceCountIs("AWS::WAFv2::WebACLAssociation", 1);
    template.hasResourceProperties("AWS::WAFv2::WebACLAssociation", {
      ResourceArn: Match.anyValue(),
      WebACLArn: Match.anyValue(),
    });
  });

  it("エッジ WAF とは別リージョン・別スタックに置かれる", () => {
    const { wafCognitoStack, wafEdgeStack } = createLabStacks();
    expect(wafCognitoStack.region).toBe(TEST_REGION);
    expect(wafEdgeStack.region).toBe("us-east-1");
  });

  // OPEN_QUESTIONS Q1 の決定: ATP / ACFP を含む WebACL は
  // Cognito ユーザープールに関連付けできない
  it("ATP / ACFP マネージドルールグループを含まない", () => {
    const serialized = JSON.stringify(template.findResources("AWS::WAFv2::WebACL"));
    expect(serialized).not.toContain("AWSManagedRulesATPRuleSet");
    expect(serialized).not.toContain("AWSManagedRulesACFPRuleSet");
  });

  // Managed Login では body が WAF に転送されず PII にマッチできないため、
  // 使えるのは IP 単位のレートベースだけ
  it("ルールは IP 単位のレートベース 1 本だけ", () => {
    const rules = rulesOf(template);
    expect(rules).toHaveLength(1);
    expect(rules[0].Name).toBe(COGNITO_RATE_RULE.name);
    expect(rules[0].Statement.RateBasedStatement?.AggregateKeyType).toBe("IP");
  });

  it("既定の閾値は 100 で context から変えられる", () => {
    expect(rulesOf(template)[0].Statement.RateBasedStatement?.Limit).toBe(100);
    expect(rulesOf(synth({ rateLimitCognito: "25" }))[0].Statement.RateBasedStatement?.Limit).toBe(
      25,
    );
  });

  // E6 はステータスコードと識別ヘッダでブロックを判定する
  // (Managed Login ではカスタム本文が返るのは最初の 1 回だけのため)
  it("ブロックは 403 と識別ヘッダで検出できる", () => {
    expect(rulesOf(template)[0].Action).toEqual({
      Block: {
        CustomResponse: {
          ResponseCode: 403,
          CustomResponseBodyKey: BLOCK_RESPONSE.bodyKey,
          ResponseHeaders: [
            { Name: BLOCK_RESPONSE.markerHeaderName, Value: BLOCK_RESPONSE.markerHeaderValue },
          ],
        },
      },
    });
  });

  it("CAPTCHA アクションを使わない(Managed Login の TOTP 登録と干渉するため)", () => {
    expect(JSON.stringify(template.findResources("AWS::WAFv2::WebACL"))).not.toContain("Captcha");
  });

  it("ログを S3 に出し、認証情報を含むヘッダを伏せる", () => {
    template.hasResourceProperties("AWS::WAFv2::LoggingConfiguration", {
      RedactedFields: [
        { SingleHeader: { Name: "authorization" } },
        { SingleHeader: { Name: "cookie" } },
      ],
    });
  });

  it("ログバケット名が CoreStack の Glue テーブルと一致する", () => {
    const bucketName = `aws-waf-logs-edge-lab-cognito-${TEST_ACCOUNT}-${TEST_REGION}`;
    template.hasResourceProperties("AWS::S3::Bucket", { BucketName: bucketName });

    const coreTemplate = Template.fromStack(createLabStacks().coreStack);
    const tables = Object.values(coreTemplate.findResources("AWS::Glue::Table")) as {
      Properties: { TableInput: { Name: string; StorageDescriptor: { Location: string } } };
    }[];
    const cognitoTable = tables.find(
      (table) => table.Properties.TableInput.Name === "cognito_waf_logs",
    );
    expect(cognitoTable?.Properties.TableInput.StorageDescriptor.Location).toContain(bucketName);
  });
});

describe("CoreStack の WAF ログテーブル", () => {
  it("エッジと Cognito で別テーブルを持つ", () => {
    const template = Template.fromStack(createLabStacks().coreStack);
    const names = (
      Object.values(template.findResources("AWS::Glue::Table")) as {
        Properties: { TableInput: { Name: string } };
      }[]
    ).map((table) => table.Properties.TableInput.Name);
    expect(names.sort()).toEqual(["cognito_waf_logs", "edge_waf_logs"]);
  });
});
