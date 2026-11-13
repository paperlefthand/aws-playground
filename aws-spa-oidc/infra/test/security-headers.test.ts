import { describe, expect, it } from "vite-plus/test";
import { buildCspHeaderValue } from "../config/csp.ts";
import {
  HSTS_MAX_AGE_SECONDS,
  PERMISSIONS_POLICY,
  buildSecurityHeaders,
} from "../config/security-headers.ts";

const cspValue = buildCspHeaderValue({
  region: "ap-northeast-1",
  cognitoDomain: "edge-lab-123456789012.auth.ap-northeast-1.amazoncognito.com",
  trustedTypes: false,
});

describe("buildSecurityHeaders", () => {
  it("SPEC 4.2 のヘッダ値を出す", () => {
    const headers = buildSecurityHeaders({ cspMode: "off", cspValue: undefined });
    expect(headers.native.strictTransportSecurity.accessControlMaxAgeSeconds).toBe(
      HSTS_MAX_AGE_SECONDS,
    );
    expect(headers.native.strictTransportSecurity.includeSubdomains).toBe(true);
    // preload は不可逆なので既定では付けない
    expect(headers.native.strictTransportSecurity.preload).toBe(false);
    expect(headers.native.frameOptions).toBe("DENY");
    expect(headers.native.referrerPolicy).toBe("strict-origin-when-cross-origin");
    expect(headers.custom["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(headers.custom["Cross-Origin-Resource-Policy"]).toBe("same-origin");
  });

  // OPEN_QUESTIONS Q4 の決定: 廃止された interest-cohort は使わない
  it("Permissions-Policy は browsing-topics を使い interest-cohort を含まない", () => {
    expect(PERMISSIONS_POLICY).toContain("browsing-topics=()");
    expect(PERMISSIONS_POLICY).not.toContain("interest-cohort");
  });

  it("cspMode=off のとき CSP 関連ヘッダを一切出さない", () => {
    const headers = buildSecurityHeaders({ cspMode: "off", cspValue: undefined });
    expect(headers.native.contentSecurityPolicy).toBeUndefined();
    expect(headers.custom["Content-Security-Policy-Report-Only"]).toBeUndefined();
    expect(headers.custom["Reporting-Endpoints"]).toBeUndefined();
  });

  it("cspMode=enforce はネイティブフィールドに載せる", () => {
    const headers = buildSecurityHeaders({ cspMode: "enforce", cspValue });
    expect(headers.native.contentSecurityPolicy).toBe(cspValue);
    expect(headers.custom["Content-Security-Policy-Report-Only"]).toBeUndefined();
    expect(headers.custom["Reporting-Endpoints"]).toContain("csp-endpoint=");
  });

  // SPEC 4.2: ResponseHeadersPolicy のネイティブ CSP は enforce 専用
  it("cspMode=report-only は customHeaders に Report-Only として出す", () => {
    const headers = buildSecurityHeaders({ cspMode: "report-only", cspValue });
    expect(headers.native.contentSecurityPolicy).toBeUndefined();
    expect(headers.custom["Content-Security-Policy-Report-Only"]).toBe(cspValue);
  });

  it("cspMode が off 以外なのに値が無ければ例外にする", () => {
    expect(() => buildSecurityHeaders({ cspMode: "enforce", cspValue: undefined })).toThrow(/必須/);
  });
});
