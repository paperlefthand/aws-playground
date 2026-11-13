import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { PERMISSIONS_POLICY } from "../config/security-headers.ts";
import { createLabStacks } from "./helpers.ts";

function synth(context: Record<string, unknown> = {}): Template {
  return Template.fromStack(createLabStacks(context).deliveryStack);
}

/** 論理 ID の接頭辞でディストリビューションを取り出す */
function distributions(template: Template): Record<string, DistributionResource> {
  return template.findResources("AWS::CloudFront::Distribution") as Record<
    string,
    DistributionResource
  >;
}

/** AWS マネージドポリシー CachingDisabled の ID */
const CACHING_DISABLED_POLICY_ID = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";

interface DistributionResource {
  Properties: {
    DistributionConfig: {
      WebACLId?: unknown;
      DefaultCacheBehavior: {
        CachePolicyId?: string;
        ResponseHeadersPolicyId?: unknown;
        FunctionAssociations?: { EventType: string }[];
      };
      CacheBehaviors?: { PathPattern: string; ResponseHeadersPolicyId?: unknown }[];
      CustomErrorResponses?: unknown[];
      Origins: { OriginCustomHeaders?: { HeaderName: string; HeaderValue: string }[] }[];
    };
  };
}

function pick(template: Template, prefix: string): DistributionResource {
  const entry = Object.entries(distributions(template)).find(([id]) => id.startsWith(prefix));
  if (!entry) {
    throw new Error(`${prefix} で始まるディストリビューションが見つかりません`);
  }
  return entry[1];
}

describe("DeliveryStack", () => {
  let template: Template;

  beforeAll(() => {
    template = synth();
  });

  it("hardened と baseline の 2 本を同じオリジンに対して立てる(SPEC 2.1)", () => {
    expect(Object.keys(distributions(template))).toHaveLength(2);
  });

  // SPEC 4.8 の必須検証項目
  it("hardened には WebACL と ResponseHeadersPolicy が紐づく", () => {
    const config = pick(template, "HardenedDistribution").Properties.DistributionConfig;
    expect(config.WebACLId).toBeDefined();
    expect(config.DefaultCacheBehavior.ResponseHeadersPolicyId).toBeDefined();
    for (const behavior of config.CacheBehaviors ?? []) {
      expect(behavior.ResponseHeadersPolicyId).toBeDefined();
    }
  });

  it("baseline には WebACL も ResponseHeadersPolicy も紐づかない", () => {
    const config = pick(template, "BaselineDistribution").Properties.DistributionConfig;
    expect(config.WebACLId).toBeUndefined();
    expect(config.DefaultCacheBehavior.ResponseHeadersPolicyId).toBeUndefined();
    for (const behavior of config.CacheBehaviors ?? []) {
      expect(behavior.ResponseHeadersPolicyId).toBeUndefined();
    }
  });

  // SPEC 4.2: WAF の block(403)が 200 の index.html にすり替わらないようにする
  it("カスタムエラーレスポンスを使わず CloudFront Function で書き換える", () => {
    for (const distribution of Object.values(distributions(template))) {
      const config = distribution.Properties.DistributionConfig;
      expect(config.CustomErrorResponses).toBeUndefined();
      expect(config.DefaultCacheBehavior.FunctionAssociations).toHaveLength(1);
      expect(config.DefaultCacheBehavior.FunctionAssociations?.[0].EventType).toBe(
        "viewer-request",
      );
    }
  });

  it("SPA ルータは viewer-request の CloudFront Function として作られる", () => {
    template.hasResourceProperties("AWS::CloudFront::Function", {
      FunctionConfig: Match.objectLike({ Runtime: "cloudfront-js-2.0" }),
    });
  });

  it("/api/* は Origin Custom Header 付きで API に向く", () => {
    const origins = pick(template, "HardenedDistribution").Properties.DistributionConfig.Origins;
    const apiOrigin = origins.find((origin) => origin.OriginCustomHeaders !== undefined);
    expect(apiOrigin?.OriginCustomHeaders).toHaveLength(1);
    expect(apiOrigin?.OriginCustomHeaders?.[0].HeaderName).toBe("x-lab-origin-secret");
    // 秘密の値そのものではなく動的参照が載っていること(SPEC 6)
    const value = JSON.stringify(apiOrigin?.OriginCustomHeaders?.[0].HeaderValue);
    expect(value).toContain("{{resolve:secretsmanager:");
  });

  it("ハッシュ付きアセットは長期キャッシュする", () => {
    template.hasResourceProperties("AWS::CloudFront::CachePolicy", {
      CachePolicyConfig: Match.objectLike({
        DefaultTTL: 31_536_000,
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          EnableAcceptEncodingGzip: true,
        }),
      }),
    });
  });

  // index.html は CSP を変えたときに即時反映させたいのでエッジに保持しない
  it("既定ビヘイビアはマネージドの CachingDisabled を使う", () => {
    const config = pick(template, "HardenedDistribution").Properties.DistributionConfig;
    expect(config.DefaultCacheBehavior.CachePolicyId).toBe(CACHING_DISABLED_POLICY_ID);
  });

  // maxTtl=0 の自前ポリシーに圧縮フラグを付けるとデプロイが 400 で落ちる
  // (The parameter EnableAcceptEncodingGzip is invalid for policy with caching disabled)
  it("キャッシュ無効の自前ポリシーに圧縮フラグを付けない", () => {
    const policies = Object.values(template.findResources("AWS::CloudFront::CachePolicy")) as {
      Properties: {
        CachePolicyConfig: {
          MaxTTL: number;
          ParametersInCacheKeyAndForwardedToOrigin?: {
            EnableAcceptEncodingGzip?: boolean;
            EnableAcceptEncodingBrotli?: boolean;
          };
        };
      };
    }[];
    const invalid = policies.filter((policy) => {
      const config = policy.Properties.CachePolicyConfig;
      const params = config.ParametersInCacheKeyAndForwardedToOrigin;
      return (
        config.MaxTTL === 0 &&
        (params?.EnableAcceptEncodingGzip === true || params?.EnableAcceptEncodingBrotli === true)
      );
    });
    expect(invalid).toEqual([]);
  });

  it("アクセスログを両方のディストリビューションで取る", () => {
    for (const distribution of Object.values(distributions(template))) {
      const config = distribution.Properties.DistributionConfig as { Logging?: unknown };
      expect(config.Logging).toBeDefined();
    }
  });
});

describe("DeliveryStack: セキュリティヘッダ", () => {
  it("cspMode=off のとき CSP を一切出さない", () => {
    const template = synth({ cspMode: "off" });
    const policies = Object.values(
      template.findResources("AWS::CloudFront::ResponseHeadersPolicy"),
    );
    const serialized = JSON.stringify(policies);
    expect(serialized).not.toContain("Content-Security-Policy");
    // CSP 以外のヘッダは付ける
    expect(serialized).toContain(PERMISSIONS_POLICY);
  });

  // SPEC 4.8 の必須検証項目
  it("cspMode=enforce のとき CSP ヘッダがあり 'unsafe-inline' を含まない", () => {
    const template = synth({ cspMode: "enforce" });
    const policies = Object.values(
      template.findResources("AWS::CloudFront::ResponseHeadersPolicy"),
    ) as { Properties: { ResponseHeadersPolicyConfig: Record<string, unknown> } }[];

    for (const policy of policies) {
      const config = policy.Properties.ResponseHeadersPolicyConfig as {
        SecurityHeadersConfig: { ContentSecurityPolicy?: { ContentSecurityPolicy: string } };
      };
      const csp = config.SecurityHeadersConfig.ContentSecurityPolicy?.ContentSecurityPolicy;
      expect(csp).toBeDefined();
      // Cognito ドメインがトークンなので Fn::Join として出る。文字列化して見る。
      const serialized = JSON.stringify(csp);
      expect(serialized).toContain("default-src 'none'");
      expect(serialized).not.toContain("unsafe-inline");
      expect(serialized).not.toContain("unsafe-eval");
    }
  });

  // SPEC 4.2: ネイティブ CSP フィールドは enforce 専用
  it("cspMode=report-only は Report-Only をカスタムヘッダで出す", () => {
    const template = synth({ cspMode: "report-only" });
    const serialized = JSON.stringify(
      template.findResources("AWS::CloudFront::ResponseHeadersPolicy"),
    );
    expect(serialized).toContain("Content-Security-Policy-Report-Only");
    expect(serialized).toContain("Reporting-Endpoints");

    const policies = Object.values(
      template.findResources("AWS::CloudFront::ResponseHeadersPolicy"),
    ) as { Properties: { ResponseHeadersPolicyConfig: Record<string, never> } }[];
    for (const policy of policies) {
      const config = policy.Properties.ResponseHeadersPolicyConfig as unknown as {
        SecurityHeadersConfig: { ContentSecurityPolicy?: unknown };
      };
      expect(config.SecurityHeadersConfig.ContentSecurityPolicy).toBeUndefined();
    }
  });

  it("trustedTypes=true のとき Trusted Types を要求する", () => {
    const template = synth({ cspMode: "enforce", trustedTypes: "true" });
    expect(
      JSON.stringify(template.findResources("AWS::CloudFront::ResponseHeadersPolicy")),
    ).toContain("require-trusted-types-for");
  });

  it("HSTS に preload を付けない(不可逆なので既定では付けない)", () => {
    const template = synth();
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: Match.objectLike({
            AccessControlMaxAgeSec: 63_072_000,
            IncludeSubdomains: true,
            Preload: false,
          }),
        }),
      }),
    });
  });
});

describe("DeliveryStack: context 連動", () => {
  it("baselineEnabled=false のとき baseline を作らない", () => {
    const template = synth({ baselineEnabled: "false" });
    const ids = Object.keys(distributions(template));
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^HardenedDistribution/);
  });

  it("baseline が無いときは callback URL も hardened だけになる", () => {
    const template = synth({ baselineEnabled: "false" });
    const clients = Object.values(template.findResources("AWS::Cognito::UserPoolClient")) as {
      Properties: { CallbackURLs: unknown[]; LogoutURLs: unknown[] };
    }[];
    expect(clients[0].Properties.CallbackURLs).toHaveLength(1);
    expect(clients[0].Properties.LogoutURLs).toHaveLength(1);
  });
});

describe("DeliveryStack: Cognito App Client", () => {
  let template: Template;

  beforeAll(() => {
    template = synth();
  });

  // SPEC 4.1: public client / Authorization Code のみ / 暗黙フロー無効
  it("public client で Authorization Code のみを許可する", () => {
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthFlowsUserPoolClient: true,
      PreventUserExistenceErrors: "ENABLED",
    });
  });

  it("暗黙フローと直接認証フローを有効にしない", () => {
    const clients = Object.values(template.findResources("AWS::Cognito::UserPoolClient")) as {
      Properties: { AllowedOAuthFlows: string[]; ExplicitAuthFlows?: string[] };
    }[];
    expect(clients[0].Properties.AllowedOAuthFlows).not.toContain("implicit");
    expect(clients[0].Properties.ExplicitAuthFlows ?? []).not.toContain("ALLOW_USER_PASSWORD_AUTH");
  });

  it("callback URL に hardened / baseline 両方のドメインを登録する", () => {
    const clients = Object.values(template.findResources("AWS::Cognito::UserPoolClient")) as {
      Properties: { CallbackURLs: unknown[]; LogoutURLs: unknown[] };
    }[];
    expect(clients[0].Properties.CallbackURLs).toHaveLength(2);
    expect(clients[0].Properties.LogoutURLs).toHaveLength(2);
  });
});
