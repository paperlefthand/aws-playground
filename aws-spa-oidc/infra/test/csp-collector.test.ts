import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ORIGIN_SECRET_HEADER,
  decodeBody,
  handler,
  isAcceptedContentType,
  isValidOriginSecret,
  normalizeReports,
} from "../functions/csp-collector/index.mjs";

const SECRET = "s3cr3t-origin-header-value";

function event(overrides: Record<string, unknown> = {}) {
  return {
    headers: {
      [ORIGIN_SECRET_HEADER]: SECRET,
      "content-type": "application/csp-report",
      "user-agent": "Mozilla/5.0 (test)",
    },
    body: JSON.stringify({
      "csp-report": {
        "document-uri": "https://example.cloudfront.net/",
        "effective-directive": "script-src",
        "blocked-uri": "https://evil.example.com/x.js",
        "script-sample": "alert(1)",
        disposition: "enforce",
      },
    }),
    isBase64Encoded: false,
    requestContext: { requestId: "req-1", http: { sourceIp: "203.0.113.1" } },
    ...overrides,
  };
}

describe("isAcceptedContentType", () => {
  it.each(["application/csp-report", "application/reports+json"])("%s を受理する", (ct) => {
    expect(isAcceptedContentType(ct)).toBe(true);
  });

  it("charset 付きでも受理する", () => {
    expect(isAcceptedContentType("application/csp-report; charset=utf-8")).toBe(true);
  });

  it.each(["application/json", "text/plain", undefined])("%s は受理しない", (ct) => {
    expect(isAcceptedContentType(ct)).toBe(false);
  });
});

describe("isValidOriginSecret", () => {
  it("一致すれば true", () => {
    expect(isValidOriginSecret(SECRET, SECRET)).toBe(true);
  });

  it.each([
    ["値が違う", "wrong-value-with-same-length!!", SECRET],
    ["長さが違う", "short", SECRET],
    ["未提供", undefined, SECRET],
  ])("%s なら false", (_label, provided, expected) => {
    expect(isValidOriginSecret(provided, expected)).toBe(false);
  });

  // 期待値未設定のまま公開されると誰でも書き込めてしまう
  it("期待値が未設定なら閉じる", () => {
    expect(isValidOriginSecret("anything", undefined)).toBe(false);
    expect(isValidOriginSecret("anything", "")).toBe(false);
  });
});

describe("normalizeReports", () => {
  it("CSP Level 2 形式を正規化する", () => {
    const reports = normalizeReports("application/csp-report", {
      "csp-report": {
        "document-uri": "https://example.test/",
        "effective-directive": "script-src",
        "blocked-uri": "inline",
        "script-sample": "alert(1)",
      },
    });
    expect(reports).toEqual([
      {
        reportFormat: "csp-report",
        effectiveDirective: "script-src",
        blockedUri: "inline",
        documentUri: "https://example.test/",
        scriptSample: "alert(1)",
        disposition: null,
        sourceFile: null,
        lineNumber: null,
      },
    ]);
  });

  it("effective-directive が無ければ violated-directive で補う", () => {
    const [report] = normalizeReports("application/csp-report", {
      "csp-report": { "violated-directive": "style-src 'self'" },
    });
    expect(report.effectiveDirective).toBe("style-src 'self'");
  });

  it("Reporting API 形式を正規化する", () => {
    const reports = normalizeReports("application/reports+json", [
      {
        type: "csp-violation",
        url: "https://example.test/page",
        body: {
          effectiveDirective: "img-src",
          blockedURL: "https://cdn.example.com/a.png",
          documentURL: "https://example.test/page",
          sample: "",
          disposition: "report",
          lineNumber: 42,
        },
      },
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      reportFormat: "reports+json",
      effectiveDirective: "img-src",
      blockedUri: "https://cdn.example.com/a.png",
      lineNumber: 42,
    });
  });

  it("csp-violation 以外のレポート種別は無視する", () => {
    const reports = normalizeReports("application/reports+json", [
      { type: "deprecation", body: { id: "x" } },
    ]);
    expect(reports).toEqual([]);
  });

  it("形の違うボディでも落ちない", () => {
    expect(normalizeReports("application/csp-report", {})).toEqual([]);
    expect(normalizeReports("application/reports+json", { not: "an array" })).toEqual([]);
    expect(normalizeReports("text/plain", {})).toEqual([]);
  });
});

describe("decodeBody", () => {
  it("base64 のボディを復号する", () => {
    const payload = { "csp-report": { "blocked-uri": "eval" } };
    const decoded = decodeBody({
      body: Buffer.from(JSON.stringify(payload)).toString("base64"),
      isBase64Encoded: true,
    });
    expect(decoded).toEqual(payload);
  });

  it.each([
    ["JSON でない", { body: "not json", isBase64Encoded: false }],
    ["空", { body: "", isBase64Encoded: false }],
  ])("%s なら null", (_label, input) => {
    expect(decodeBody(input)).toBeNull();
  });
});

describe("handler", () => {
  beforeEach(() => {
    process.env.LAB_ORIGIN_SECRET = SECRET;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LAB_ORIGIN_SECRET;
  });

  it("正しいリクエストを 204 で受け、1 違反 1 行で記録する", async () => {
    const result = await handler(event());
    expect(result.statusCode).toBe(204);

    expect(console.log).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      kind: "csp-violation",
      effectiveDirective: "script-src",
      blockedUri: "https://evil.example.com/x.js",
      scriptSample: "alert(1)",
      userAgent: "Mozilla/5.0 (test)",
    });
    expect(logged.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // CloudFront を経由しない直叩きを弾く(同一オリジン構成なので CORS は効かない)
  it("Origin ヘッダが一致しなければ 403", async () => {
    const result = await handler(
      event({
        headers: { [ORIGIN_SECRET_HEADER]: "wrong", "content-type": "application/csp-report" },
      }),
    );
    expect(result.statusCode).toBe(403);
    expect(console.log).not.toHaveBeenCalled();
    const warned = JSON.parse(vi.mocked(console.warn).mock.calls[0][0] as string);
    expect(warned.reason).toBe("origin-secret-mismatch");
  });

  it("想定外の Content-Type は 415", async () => {
    const result = await handler(
      event({
        headers: {
          [ORIGIN_SECRET_HEADER]: SECRET,
          "content-type": "application/json",
        },
      }),
    );
    expect(result.statusCode).toBe(415);
  });

  it("壊れたボディは 400", async () => {
    const result = await handler(event({ body: "{{{" }));
    expect(result.statusCode).toBe(400);
  });

  it("大量のレポートを送られても処理件数に上限がある", async () => {
    const reports = Array.from({ length: 200 }, () => ({
      type: "csp-violation",
      body: { effectiveDirective: "script-src", blockedURL: "inline" },
    }));
    const result = await handler(
      event({
        headers: {
          [ORIGIN_SECRET_HEADER]: SECRET,
          "content-type": "application/reports+json",
        },
        body: JSON.stringify(reports),
      }),
    );
    expect(result.statusCode).toBe(204);
    expect(vi.mocked(console.log).mock.calls.length).toBeLessThanOrEqual(50);
  });
});
