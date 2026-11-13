/**
 * セキュリティヘッダの単一情報源(SPEC 4.2)。
 * hardened ディストリビューションにのみ付与し、baseline には一切付けない。
 *
 * CloudFront の ResponseHeadersPolicy はネイティブに扱えるヘッダが決まっている
 * (HSTS / X-Content-Type-Options / X-Frame-Options / Referrer-Policy /
 *  Content-Security-Policy)。それ以外と Report-Only は customHeaders で付ける。
 */

import type { CspMode } from "./context.ts";
import { CSP_REPORT_GROUP, CSP_REPORT_PATH } from "./csp.ts";

/** 2 年。`preload` は既定で付けない(不可逆性を docs/DECISIONS.md で論じる) */
export const HSTS_MAX_AGE_SECONDS = 63_072_000;
export const HSTS_INCLUDE_SUBDOMAINS = true;
export const HSTS_PRELOAD = false;

export const REFERRER_POLICY = "strict-origin-when-cross-origin";
export const FRAME_OPTIONS = "DENY";

/**
 * `interest-cohort` は FLoC 廃止で陳腐化したため後継の `browsing-topics` を使う
 * (docs/OPEN_QUESTIONS.md Q4 の決定)。
 */
export const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "browsing-topics=()",
].join(", ");

export const CROSS_ORIGIN_OPENER_POLICY = "same-origin";
export const CROSS_ORIGIN_RESOURCE_POLICY = "same-origin";
export const REPORTING_ENDPOINTS = `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;

export interface SecurityHeaderInputs {
  readonly cspMode: CspMode;
  /** cspMode が off 以外のときに使う CSP 本体 */
  readonly cspValue: string | undefined;
}

export interface NativeSecurityHeaders {
  readonly strictTransportSecurity: {
    readonly accessControlMaxAgeSeconds: number;
    readonly includeSubdomains: boolean;
    readonly preload: boolean;
  };
  readonly contentTypeOptions: true;
  readonly frameOptions: string;
  readonly referrerPolicy: string;
  /** enforce のときだけネイティブフィールドに載せる */
  readonly contentSecurityPolicy: string | undefined;
}

export interface SecurityHeaderSet {
  readonly native: NativeSecurityHeaders;
  /** ResponseHeadersPolicy の customHeadersBehavior に載せるヘッダ */
  readonly custom: Readonly<Record<string, string>>;
}

export function buildSecurityHeaders(inputs: SecurityHeaderInputs): SecurityHeaderSet {
  if (inputs.cspMode !== "off" && !inputs.cspValue) {
    throw new Error(`cspMode=${inputs.cspMode} のとき cspValue は必須です`);
  }

  const custom: Record<string, string> = {
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Cross-Origin-Opener-Policy": CROSS_ORIGIN_OPENER_POLICY,
    "Cross-Origin-Resource-Policy": CROSS_ORIGIN_RESOURCE_POLICY,
  };

  if (inputs.cspMode !== "off") {
    custom["Reporting-Endpoints"] = REPORTING_ENDPOINTS;
  }

  // SPEC 4.2: ResponseHeadersPolicy のネイティブ CSP フィールドは enforce 専用。
  // Report-Only は customHeaders で付けるしかない。
  if (inputs.cspMode === "report-only" && inputs.cspValue) {
    custom["Content-Security-Policy-Report-Only"] = inputs.cspValue;
  }

  return {
    native: {
      strictTransportSecurity: {
        accessControlMaxAgeSeconds: HSTS_MAX_AGE_SECONDS,
        includeSubdomains: HSTS_INCLUDE_SUBDOMAINS,
        preload: HSTS_PRELOAD,
      },
      contentTypeOptions: true,
      frameOptions: FRAME_OPTIONS,
      referrerPolicy: REFERRER_POLICY,
      contentSecurityPolicy: inputs.cspMode === "enforce" ? inputs.cspValue : undefined,
    },
    custom,
  };
}
