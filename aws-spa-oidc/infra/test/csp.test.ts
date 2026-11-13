import { describe, expect, it } from "vite-plus/test";
import {
  CSP_CURRENT_VERSION,
  CSP_REPORT_GROUP,
  CSP_REPORT_PATH,
  CSP_VERSION_HISTORY,
  assertNoUnsafeSources,
  buildCspDirectives,
  buildCspHeaderValue,
  serializeCsp,
} from "../config/csp.ts";

const inputs = {
  region: "ap-northeast-1",
  cognitoDomain: "edge-lab-123456789012.auth.ap-northeast-1.amazoncognito.com",
  trustedTypes: false,
};

describe("buildCspDirectives", () => {
  it("default-src 'none' を起点にする", () => {
    const csp = buildCspHeaderValue(inputs);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("script-src / style-src は 'self' のみ(nonce・ハッシュに依存しない)", () => {
    const csp = buildCspHeaderValue(inputs);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
  });

  // SPEC 4.3 / SPEC 6: 「動かないから足す」を機械的に禁止する
  it("'unsafe-inline' / 'unsafe-eval' を含まない", () => {
    expect(buildCspHeaderValue(inputs)).not.toContain("unsafe-inline");
    expect(buildCspHeaderValue(inputs)).not.toContain("unsafe-eval");
    expect(buildCspHeaderValue({ ...inputs, trustedTypes: true })).not.toContain("unsafe-");
  });

  it("Cognito は別オリジンなので connect-src / form-action に入れる", () => {
    const csp = buildCspHeaderValue(inputs);
    expect(csp).toContain(`https://${inputs.cognitoDomain}`);
    expect(csp).toContain("https://cognito-idp.ap-northeast-1.amazonaws.com");

    const formAction = buildCspDirectives(inputs).find(([name]) => name === "form-action");
    expect(formAction?.[1]).toEqual(["'self'", `https://${inputs.cognitoDomain}`]);
  });

  it("レポート先が Reporting-Endpoints ヘッダと一致する", () => {
    const csp = buildCspHeaderValue(inputs);
    expect(csp).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(csp).toContain(`report-to ${CSP_REPORT_GROUP}`);
  });

  it("trustedTypes=true のとき Trusted Types を要求する", () => {
    const csp = buildCspHeaderValue({ ...inputs, trustedTypes: true });
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain("trusted-types default");
  });

  it("trustedTypes=false のとき Trusted Types を付けない", () => {
    expect(buildCspHeaderValue(inputs)).not.toContain("trusted-types");
  });

  it("値を持たないディレクティブは名前だけを出力する", () => {
    expect(serializeCsp([["upgrade-insecure-requests", []]])).toBe("upgrade-insecure-requests");
  });
});

describe("assertNoUnsafeSources", () => {
  it.each(["'unsafe-inline'", "'unsafe-eval'"])("%s を検出して例外にする", (token) => {
    expect(() => assertNoUnsafeSources(`script-src 'self' ${token}`)).toThrow(/禁止/);
  });
});

describe("CSP_VERSION_HISTORY", () => {
  it("CSP_CURRENT_VERSION が履歴の最新と一致する", () => {
    const latest = CSP_VERSION_HISTORY.at(-1);
    expect(latest?.version).toBe(CSP_CURRENT_VERSION);
  });

  it("バージョンは 1 から連番", () => {
    expect(CSP_VERSION_HISTORY.map((entry) => entry.version)).toEqual(
      CSP_VERSION_HISTORY.map((_, index) => index + 1),
    );
  });

  // v2 以降は必ず実測に基づく変更であること(想像で値を書かない / SPEC 6)
  it("v2 以降は観測の根拠を持つ", () => {
    const withoutEvidence = CSP_VERSION_HISTORY.filter(
      (entry) => entry.version > 1 && (entry.observedAt === null || entry.evidence === null),
    ).map((entry) => `v${entry.version}`);
    expect(withoutEvidence).toEqual([]);
  });
});
