import { describe, expect, it } from "vite-plus/test";
import {
  BLOCK_RESPONSE,
  COGNITO_RATE_RULE,
  EDGE_MANAGED_RULE_GROUPS,
  GEO_MATCH_RULE,
  RATE_RULE_ALL,
  RATE_RULE_API,
  REDACTED_LOG_HEADERS,
} from "../config/waf-rules.ts";

describe("EDGE_MANAGED_RULE_GROUPS", () => {
  it("SPEC 4.4 の優先度どおりに並ぶ", () => {
    expect(EDGE_MANAGED_RULE_GROUPS.map((rule) => rule.priority)).toEqual([10, 20, 30, 40, 50]);
  });

  it("優先度がレートベース / GeoMatch と衝突しない", () => {
    const priorities = [
      ...EDGE_MANAGED_RULE_GROUPS.map((rule) => rule.priority),
      RATE_RULE_ALL.priority,
      RATE_RULE_API.priority,
      GEO_MATCH_RULE.priority,
    ];
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it("ルール名はメトリクス名として一意", () => {
    const names = EDGE_MANAGED_RULE_GROUPS.map((rule) => rule.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // 誤検知の出やすいルールを黙って Block にしないための歯止め
  it("常時 Count のルールには理由が書かれている", () => {
    const withoutReason = EDGE_MANAGED_RULE_GROUPS.filter(
      (rule) => rule.alwaysCount && !rule.note,
    ).map((rule) => rule.name);
    expect(withoutReason).toEqual([]);
  });

  it("AnonymousIpList は常に Count(FP 分析の素材)", () => {
    const rule = EDGE_MANAGED_RULE_GROUPS.find((r) => r.name === "AWSManagedRulesAnonymousIpList");
    expect(rule?.alwaysCount).toBe(true);
  });

  // SPEC 4.4: 除外には理由と観測日時が必須
  it("ルール除外があるときは理由が書かれている", () => {
    const withoutReason = EDGE_MANAGED_RULE_GROUPS.filter(
      (rule) => rule.excludedRules.length > 0 && !rule.note,
    ).map((rule) => rule.name);
    expect(withoutReason).toEqual([]);
  });
});

describe("レートベース / 可視化ルール", () => {
  it("/api/* の閾値ルールは CloudFront のビヘイビアと同じ接頭辞を見る", () => {
    expect(RATE_RULE_API.pathPrefix).toBe("/api/");
  });

  it("GeoMatch は可視化専用で Cognito 側とは別の優先度を持つ", () => {
    expect(GEO_MATCH_RULE.priority).toBe(200);
    expect(COGNITO_RATE_RULE.priority).toBe(10);
  });
});

describe("ロギングとブロック応答", () => {
  it("認証情報を含むヘッダを redact する", () => {
    expect(REDACTED_LOG_HEADERS).toContain("authorization");
    expect(REDACTED_LOG_HEADERS).toContain("cookie");
    // WAF の redactedFields はヘッダ名を小文字で扱う
    for (const header of REDACTED_LOG_HEADERS) {
      expect(header).toBe(header.toLowerCase());
    }
  });

  // SPEC 4.2: WAF の block を 200 の index.html にすり替えさせないための識別子
  it("ブロック応答が 403 + JSON + 識別ヘッダで計測可能", () => {
    expect(BLOCK_RESPONSE.statusCode).toBe(403);
    expect(BLOCK_RESPONSE.contentType).toBe("application/json");
    expect(BLOCK_RESPONSE.markerHeaderName).toBe("x-lab-blocked-by");
    expect(() => JSON.parse(BLOCK_RESPONSE.body)).not.toThrow();
  });
});
