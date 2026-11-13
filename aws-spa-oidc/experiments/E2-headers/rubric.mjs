/**
 * レスポンスヘッダの採点ルーブリック(実験 E2)。
 *
 * 期待値は `infra/config/security-headers.ts` の定義に対応する。片方だけ変えると
 * 「設定したのに落ちる / 落ちていないのに通る」が起きるので、SPEC 4.2 の表を
 * 変えたときは両方直すこと。
 *
 * 採点は自前ルーブリックのみ。外部採点サービス(securityheaders.com 等)のスコアは
 * 手で記録する欄を CSV に用意する(SPEC 4.7)。**数値を想像で埋めないこと。**
 */

import { findHeader } from "../lib/waf.mjs";

/** 1 項目 1 点。hardened で満点、baseline で 0 点になる想定 */
export const RUBRIC = [
  {
    id: "hsts",
    header: "strict-transport-security",
    description: "HSTS が 1 年以上かつ includeSubDomains",
    check: (value) => {
      if (!value) return false;
      const maxAge = /max-age=(\d+)/.exec(value);
      return maxAge !== null && Number(maxAge[1]) >= 31_536_000 && /includesubdomains/i.test(value);
    },
  },
  {
    id: "content-type-options",
    header: "x-content-type-options",
    description: "X-Content-Type-Options: nosniff",
    check: (value) => value?.toLowerCase() === "nosniff",
  },
  {
    id: "frame-options",
    header: "x-frame-options",
    description: "X-Frame-Options: DENY",
    check: (value) => value?.toUpperCase() === "DENY",
  },
  {
    id: "referrer-policy",
    header: "referrer-policy",
    description: "Referrer-Policy が strict-origin-when-cross-origin 以上",
    check: (value) =>
      value !== undefined &&
      ["strict-origin-when-cross-origin", "strict-origin", "no-referrer"].includes(
        value.toLowerCase(),
      ),
  },
  {
    id: "permissions-policy",
    header: "permissions-policy",
    description: "Permissions-Policy で主要な機能を無効化",
    check: (value) =>
      value !== undefined &&
      ["camera=()", "microphone=()", "geolocation=()"].every((d) => value.includes(d)),
  },
  {
    id: "coop",
    header: "cross-origin-opener-policy",
    description: "Cross-Origin-Opener-Policy: same-origin",
    check: (value) => value?.toLowerCase() === "same-origin",
  },
  {
    id: "corp",
    header: "cross-origin-resource-policy",
    description: "Cross-Origin-Resource-Policy: same-origin",
    check: (value) => value?.toLowerCase() === "same-origin",
  },
  {
    id: "csp",
    header: "content-security-policy",
    description: "CSP が enforce で default-src 'none' を持つ",
    check: (value) => value !== undefined && value.includes("default-src 'none'"),
  },
  {
    id: "csp-no-unsafe",
    header: "content-security-policy",
    description: "CSP に 'unsafe-inline' / 'unsafe-eval' が無い",
    // ヘッダ自体が無い場合は「安全」ではないので加点しない
    check: (value) =>
      value !== undefined && !value.includes("unsafe-inline") && !value.includes("unsafe-eval"),
  },
  {
    id: "reporting-endpoints",
    header: "reporting-endpoints",
    description: "Reporting-Endpoints で csp-endpoint を宣言",
    check: (value) => value?.includes("csp-endpoint") === true,
  },
];

/**
 * report-only 運用のときは enforce 用の項目が落ちるのが正しい。
 * その事実を「落ちた」ではなく「その運用である」と読めるように別枠で見る。
 */
export const REPORT_ONLY_HEADER = "content-security-policy-report-only";

/**
 * @param {Record<string, string>} headers
 */
export function scoreHeaders(headers) {
  const checks = RUBRIC.map((item) => {
    const value = findHeader(headers, item.header);
    return {
      id: item.id,
      header: item.header,
      description: item.description,
      value: value ?? "",
      pass: item.check(value) === true,
    };
  });

  return {
    checks,
    passed: checks.filter((check) => check.pass).length,
    total: checks.length,
    cspMode: detectCspMode(headers),
  };
}

/**
 * CSP の運用モードを応答から判定する。
 * @param {Record<string, string>} headers
 */
export function detectCspMode(headers) {
  if (findHeader(headers, "content-security-policy")) {
    return "enforce";
  }
  if (findHeader(headers, REPORT_ONLY_HEADER)) {
    return "report-only";
  }
  return "off";
}

/**
 * hardened / baseline を 1 行 1 項目で並べた比較表にする。
 * 外部採点サービスのスコアは手で埋める欄として空で出す(SPEC 6)。
 */
export function toComparisonRows(hardened, baseline) {
  return RUBRIC.map((item, index) => ({
    id: item.id,
    description: item.description,
    hardened_pass: hardened.checks[index].pass ? 1 : 0,
    hardened_value: hardened.checks[index].value,
    baseline_pass: baseline ? (baseline.checks[index].pass ? 1 : 0) : "",
    baseline_value: baseline ? baseline.checks[index].value : "",
  }));
}
