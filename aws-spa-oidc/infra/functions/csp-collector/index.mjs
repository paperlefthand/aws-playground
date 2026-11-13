/**
 * CSP 違反レポート収集 Lambda(SPEC 4.1)。
 *
 * - `POST /api/csp-report` のみ。CloudFront の /api/* ビヘイビア経由で到達する。
 * - `application/csp-report`(CSP Level 2/3 の report-uri)と
 *   `application/reports+json`(Reporting API の report-to)の両方を受理する。
 * - 受信ボディを構造化 JSON にして CloudWatch Logs に出す。集計は E3 が
 *   Logs Insights で行うため、1 違反 = 1 行の JSON で出力する。
 * - CloudFront が付ける Origin Custom Header を検証し、API を直叩きされた
 *   リクエストは 403 で弾く(同一オリジン化して CORS を回避する構成のため、
 *   ブラウザ側の防御は効かない)。
 *
 * 依存ライブラリなし(Lambda ランタイム同梱のものだけを使う)。
 */

import { timingSafeEqual } from "node:crypto";

export const ORIGIN_SECRET_HEADER = "x-lab-origin-secret";

/** 受理する Content-Type(パラメータ付きも許容するため前方一致で判定する) */
export const ACCEPTED_CONTENT_TYPES = ["application/csp-report", "application/reports+json"];

/** 1 リクエストあたりの処理上限。違反レポートによる DoS を抑える */
export const MAX_REPORTS_PER_REQUEST = 50;

export function isAcceptedContentType(contentType) {
  if (typeof contentType !== "string") {
    return false;
  }
  const base = contentType.split(";")[0].trim().toLowerCase();
  return ACCEPTED_CONTENT_TYPES.includes(base);
}

/**
 * 期待値との定数時間比較。長さが違う場合も分岐時間を揃える。
 */
export function isValidOriginSecret(provided, expected) {
  if (typeof expected !== "string" || expected === "") {
    // 秘密が未設定のまま公開されるのを防ぐため、閉じる側に倒す
    return false;
  }
  if (typeof provided !== "string") {
    return false;
  }
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * CSP Level 2 形式と Reporting API 形式を共通のレコードに正規化する。
 *
 * @returns {{ effectiveDirective: string|null, blockedUri: string|null,
 *   documentUri: string|null, scriptSample: string|null, disposition: string|null,
 *   sourceFile: string|null, lineNumber: number|null, reportFormat: string }[]}
 */
export function normalizeReports(contentType, payload) {
  const base = String(contentType ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (base === "application/csp-report") {
    const report = payload?.["csp-report"];
    if (!report || typeof report !== "object") {
      return [];
    }
    return [
      {
        reportFormat: "csp-report",
        effectiveDirective: str(report["effective-directive"] ?? report["violated-directive"]),
        blockedUri: str(report["blocked-uri"]),
        documentUri: str(report["document-uri"]),
        scriptSample: str(report["script-sample"]),
        disposition: str(report.disposition),
        sourceFile: str(report["source-file"]),
        lineNumber: num(report["line-number"]),
      },
    ];
  }

  if (base === "application/reports+json") {
    const reports = Array.isArray(payload) ? payload : [];
    return reports
      .filter((entry) => entry?.type === "csp-violation" && entry.body)
      .slice(0, MAX_REPORTS_PER_REQUEST)
      .map((entry) => ({
        reportFormat: "reports+json",
        effectiveDirective: str(entry.body.effectiveDirective),
        blockedUri: str(entry.body.blockedURL),
        documentUri: str(entry.body.documentURL ?? entry.url),
        scriptSample: str(entry.body.sample),
        disposition: str(entry.body.disposition),
        sourceFile: str(entry.body.sourceFile),
        lineNumber: num(entry.body.lineNumber),
      }));
  }

  return [];
}

function str(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value) {
  return Number.isFinite(value) ? value : null;
}

export function decodeBody(event) {
  if (typeof event?.body !== "string" || event.body === "") {
    return null;
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function response(statusCode, message) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  };
}

export const handler = async (event) => {
  const headers = event?.headers ?? {};

  if (!isValidOriginSecret(headers[ORIGIN_SECRET_HEADER], process.env.LAB_ORIGIN_SECRET)) {
    // 直叩きの試行自体も観測対象なので記録する
    console.warn(
      JSON.stringify({
        kind: "csp-collector.rejected",
        reason: "origin-secret-mismatch",
        sourceIp: event?.requestContext?.http?.sourceIp ?? null,
      }),
    );
    return response(403, "Forbidden");
  }

  const contentType = headers["content-type"];
  if (!isAcceptedContentType(contentType)) {
    return response(415, "Unsupported Media Type");
  }

  const payload = decodeBody(event);
  if (payload === null) {
    return response(400, "Bad Request");
  }

  const receivedAt = new Date().toISOString();
  const reports = normalizeReports(contentType, payload);

  for (const report of reports) {
    // 1 違反 = 1 行。E3 の Logs Insights クエリはこの kind で絞り込む
    console.log(
      JSON.stringify({
        kind: "csp-violation",
        receivedAt,
        userAgent: headers["user-agent"] ?? null,
        requestId: event?.requestContext?.requestId ?? null,
        ...report,
      }),
    );
  }

  if (reports.length === 0) {
    console.warn(
      JSON.stringify({
        kind: "csp-collector.empty",
        receivedAt,
        contentType: String(contentType),
      }),
    );
  }

  return { statusCode: 204, headers: {}, body: "" };
};
