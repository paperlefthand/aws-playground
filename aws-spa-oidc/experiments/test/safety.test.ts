import { describe, expect, it } from "vite-plus/test";
import { parseArgs, parseLoadOptions } from "../lib/cli.mjs";
import {
  ACK_FLAG,
  DEFAULT_MAX_RPS,
  HARD_MAX_RPS,
  intervalMsFor,
  resolveLoadProfile,
} from "../lib/safety.mjs";
import {
  assertAllowedTarget,
  collectAllowedHosts,
  parseTargets,
  requireBaseline,
} from "../lib/targets.mjs";

const outputs = {
  "edge-lab-core": {
    UserPoolId: "ap-northeast-1_AbCdEfGh",
    Region: "ap-northeast-1",
    CspReportApiEndpoint: "https://abc123.execute-api.ap-northeast-1.amazonaws.com",
  },
  "edge-lab-delivery": {
    HardenedUrl: "https://d111.cloudfront.net",
    BaselineUrl: "https://d222.cloudfront.net",
    UserPoolClientId: "1example23456789",
    CognitoDomain: "edge-lab-123456789012.auth.ap-northeast-1.amazoncognito.com",
  },
};

describe("parseTargets", () => {
  it("スタック名によらず出力名で対象を組み立てる", () => {
    const targets = parseTargets(outputs);
    expect(targets.hardenedUrl).toBe("https://d111.cloudfront.net");
    expect(targets.baselineUrl).toBe("https://d222.cloudfront.net");
    expect(targets.clientId).toBe("1example23456789");
  });

  it("HardenedUrl が無ければ例外", () => {
    expect(() => parseTargets({ x: { Foo: "bar" } })).toThrow(/HardenedUrl/);
  });

  it("baselineEnabled=false の構成でも読める", () => {
    const withoutBaseline = {
      ...outputs,
      "edge-lab-delivery": { HardenedUrl: "https://d111.cloudfront.net" },
    };
    const targets = parseTargets(withoutBaseline);
    expect(targets.baselineUrl).toBeUndefined();
    expect(() => requireBaseline(targets)).toThrow(/baseline/);
  });
});

describe("assertAllowedTarget", () => {
  const allowed = collectAllowedHosts(parseTargets(outputs));

  it("CDK 出力に現れたホストは許可する", () => {
    expect(() => assertAllowedTarget("https://d111.cloudfront.net/", allowed)).not.toThrow();
    expect(() =>
      assertAllowedTarget(
        "https://edge-lab-123456789012.auth.ap-northeast-1.amazoncognito.com/login",
        allowed,
      ),
    ).not.toThrow();
  });

  // 安全弁の中核。自分のリソース以外には実行できないこと(SPEC 4.7)
  it.each(["https://example.com/", "https://d333.cloudfront.net/", "http://localhost:8080/"])(
    "%s のような対象は拒否する",
    (url) => {
      expect(() => assertAllowedTarget(url, allowed)).toThrow(/含まれていません/);
    },
  );

  it("URL として解釈できない対象は拒否する", () => {
    expect(() => assertAllowedTarget("not a url", allowed)).toThrow(/不正/);
  });
});

describe("resolveLoadProfile", () => {
  it("既定値は低く固定されている", () => {
    const profile = resolveLoadProfile();
    expect(profile.rps).toBe(DEFAULT_MAX_RPS);
    expect(profile.approved).toBe(false);
  });

  // 事前承認なしに既定を超える負荷をかけられないこと(AWS 侵入テストポリシー)
  it("既定を超える指定は明示フラグ無しでは拒否する", () => {
    expect(() => resolveLoadProfile({ rps: DEFAULT_MAX_RPS + 1 })).toThrow(/上限/);
    expect(() => resolveLoadProfile({ vus: 100 })).toThrow(/上限/);
    expect(() => resolveLoadProfile({ durationSeconds: 600 })).toThrow(/上限/);
  });

  it("明示フラグがあれば既定を超えられる", () => {
    expect(resolveLoadProfile({ rps: 50, approved: true }).rps).toBe(50);
  });

  it("明示フラグがあっても絶対上限は超えられない", () => {
    expect(() => resolveLoadProfile({ rps: HARD_MAX_RPS + 1, approved: true })).toThrow(/絶対上限/);
  });

  it.each([0, -1, Number.NaN])("不正な値 %s は拒否する", (rps) => {
    expect(() => resolveLoadProfile({ rps })).toThrow(/正の数/);
  });
});

describe("intervalMsFor", () => {
  it("RPS を間隔に変換する", () => {
    expect(intervalMsFor(10)).toBe(100);
    expect(intervalMsFor(3)).toBe(334);
  });
});

describe("parseArgs", () => {
  it("--key=value と --flag を解釈する", () => {
    const { flags, values } = parseArgs(["--rps=5", "--path=/api/x", ACK_FLAG]);
    expect(values).toEqual({ rps: "5", path: "/api/x" });
    expect(flags.has(ACK_FLAG)).toBe(true);
  });

  it("形式が違う引数は拒否する", () => {
    expect(() => parseArgs(["rps=5"])).toThrow(/形式/);
  });

  it("負荷オプションを安全弁に渡せる形にする", () => {
    const { load } = parseLoadOptions(["--rps=7", "--duration=30", ACK_FLAG]);
    expect(load).toEqual({ rps: 7, vus: undefined, durationSeconds: 30, approved: true });
  });

  it("数値でない負荷オプションは拒否する", () => {
    expect(() => parseLoadOptions(["--rps=fast"])).toThrow(/数値/);
  });
});
