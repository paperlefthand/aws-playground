import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import {
  BLOCK_RESPONSE,
  EDGE_MANAGED_RULE_GROUPS,
  GEO_MATCH_RULE,
  RATE_RULE_ALL,
  RATE_RULE_API,
} from "../config/waf-rules.ts";
import { TEST_ACCOUNT, createLabStacks } from "./helpers.ts";

interface WebAclRule {
  Name: string;
  Priority: number;
  OverrideAction?: Record<string, unknown>;
  Action?: Record<string, unknown>;
  Statement: RateBasedStatement | Record<string, unknown>;
  VisibilityConfig: { CloudWatchMetricsEnabled: boolean; MetricName: string };
}

interface RateBasedStatement {
  RateBasedStatement: {
    Limit: number;
    ScopeDownStatement?: { ByteMatchStatement: { SearchString: string } };
  };
}

function rateStatement(rule: WebAclRule | undefined): RateBasedStatement["RateBasedStatement"] {
  const statement = (rule?.Statement as RateBasedStatement | undefined)?.RateBasedStatement;
  if (!statement) {
    throw new Error(`${rule?.Name ?? "(不明)"} は rateBasedStatement を持っていません`);
  }
  return statement;
}

function synth(context: Record<string, unknown> = {}): Template {
  return Template.fromStack(createLabStacks(context).wafEdgeStack);
}

function rulesOf(template: Template): WebAclRule[] {
  const acls = Object.values(template.findResources("AWS::WAFv2::WebACL")) as {
    Properties: { Rules: WebAclRule[] };
  }[];
  return acls[0].Properties.Rules;
}

describe("WafEdgeStack", () => {
  let template: Template;

  beforeAll(() => {
    template = synth();
  });

  it("CLOUDFRONT スコープの WebACL を us-east-1 に作る", () => {
    template.hasResourceProperties("AWS::WAFv2::WebACL", {
      Scope: "CLOUDFRONT",
      DefaultAction: { Allow: {} },
    });
    expect(createLabStacks().wafEdgeStack.region).toBe("us-east-1");
  });

  it("SPEC 4.4 の優先度・ルール名どおりに並ぶ", () => {
    const rules = rulesOf(template);
    expect(rules.map((rule) => rule.Priority)).toEqual([10, 20, 30, 40, 50, 100, 110, 200]);
    expect(rules.map((rule) => rule.Name)).toEqual([
      ...EDGE_MANAGED_RULE_GROUPS.map((spec) => spec.name),
      RATE_RULE_ALL.name,
      RATE_RULE_API.name,
      GEO_MATCH_RULE.name,
    ]);
  });

  // ルール名とメトリクス名が一致していないとレポートの表と突き合わせられない
  it("全ルールが CloudWatch メトリクスをルール名で出す", () => {
    for (const rule of rulesOf(template)) {
      expect(rule.VisibilityConfig.CloudWatchMetricsEnabled).toBe(true);
      expect(rule.VisibilityConfig.MetricName).toBe(rule.Name);
    }
  });

  it("ブロックは 403 + JSON + 識別ヘッダで計測できる", () => {
    template.hasResourceProperties("AWS::WAFv2::WebACL", {
      CustomResponseBodies: {
        [BLOCK_RESPONSE.bodyKey]: {
          Content: BLOCK_RESPONSE.body,
          ContentType: "APPLICATION_JSON",
        },
      },
    });
    const rateRule = rulesOf(template).find((rule) => rule.Name === RATE_RULE_ALL.name);
    expect(rateRule?.Action).toEqual({
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

  it("認証情報を含むヘッダをログから伏せる", () => {
    template.hasResourceProperties("AWS::WAFv2::LoggingConfiguration", {
      RedactedFields: [
        { SingleHeader: { Name: "authorization" } },
        { SingleHeader: { Name: "cookie" } },
      ],
    });
  });

  it("ログの配信先バケット名が CoreStack の Glue テーブルと一致する", () => {
    const bucketName = `aws-waf-logs-edge-lab-edge-${TEST_ACCOUNT}`;
    template.hasResourceProperties("AWS::S3::Bucket", { BucketName: bucketName });

    const coreTemplate = Template.fromStack(createLabStacks().coreStack);
    const tables = Object.values(coreTemplate.findResources("AWS::Glue::Table")) as {
      Properties: { TableInput: { StorageDescriptor: { Location: string } } };
    }[];
    expect(tables[0].Properties.TableInput.StorageDescriptor.Location).toContain(bucketName);
  });

  it("ログ配信の許可をバケットポリシーに明示的に持つ", () => {
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "AWSLogDeliveryWrite",
            Principal: { Service: "delivery.logs.amazonaws.com" },
          }),
        ]),
      }),
    });
  });
});

describe("WafEdgeStack: wafAction による切り替え", () => {
  it("wafAction=count のとき全マネージドルールが Count", () => {
    const overrides = rulesOf(synth({ wafAction: "count" }))
      .filter((rule) => rule.OverrideAction !== undefined)
      .map((rule) => [rule.Name, rule.OverrideAction] as const);
    expect(overrides).toEqual(EDGE_MANAGED_RULE_GROUPS.map((spec) => [spec.name, { Count: {} }]));
  });

  it("wafAction=block でも常時 Count のルールは Count のまま", () => {
    const rules = rulesOf(synth({ wafAction: "block" }));
    for (const spec of EDGE_MANAGED_RULE_GROUPS) {
      const rule = rules.find((candidate) => candidate.Name === spec.name);
      expect({ [spec.name]: rule?.OverrideAction }).toEqual({
        [spec.name]: spec.alwaysCount ? { Count: {} } : { None: {} },
      });
    }
  });

  it("GeoMatch は wafAction によらず常に Count", () => {
    for (const action of ["count", "block"]) {
      const rule = rulesOf(synth({ wafAction: action })).find(
        (candidate) => candidate.Name === GEO_MATCH_RULE.name,
      );
      expect(rule?.Action).toEqual({ Count: {} });
    }
  });

  it("phase=p3 は wafAction=block と同じ結果になる", () => {
    const fromPhase = rulesOf(synth({ phase: "p3" }));
    const fromFlag = rulesOf(synth({ wafAction: "block" }));
    expect(fromPhase).toEqual(fromFlag);
  });
});

describe("WafEdgeStack: レート閾値", () => {
  it("既定の閾値は全パス 300 / API 100", () => {
    const rules = rulesOf(synth());
    const all = rules.find((rule) => rule.Name === RATE_RULE_ALL.name);
    const api = rules.find((rule) => rule.Name === RATE_RULE_API.name);
    expect(rateStatement(all).Limit).toBe(300);
    expect(rateStatement(api).Limit).toBe(100);
  });

  it("context で閾値を変えられる", () => {
    const rules = rulesOf(synth({ rateLimitAll: "1000" }));
    const all = rules.find((rule) => rule.Name === RATE_RULE_ALL.name);
    expect(rateStatement(all).Limit).toBe(1000);
  });

  it("API 用のルールは /api/ で始まるパスだけを見る", () => {
    const api = rulesOf(synth()).find((rule) => rule.Name === RATE_RULE_API.name);
    expect(rateStatement(api).ScopeDownStatement?.ByteMatchStatement.SearchString).toBe("/api/");
  });
});
