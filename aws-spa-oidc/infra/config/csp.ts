/**
 * CSP ディレクティブの単一情報源(SPEC 4.3)。
 *
 * ポリシーはバージョン管理する。CSP の緩和・厳格化はすべて実験 E3
 * (CloudWatch Logs Insights による違反レポート集計)の観測結果に基づいて行い、
 * 「いつ・何を・なぜ変えたか」を CSP_VERSION_HISTORY に追記する。
 * この変遷そのものがレポートの成果物になる。
 *
 * 更新手順:
 *   1. E3 の集計で恒常的な違反(= 正当な機能がブロックされている)を特定する
 *   2. buildCspDirectives を修正する
 *   3. CSP_VERSION_HISTORY に entry を追加し、CSP_CURRENT_VERSION を上げる
 *   4. `observedAt` に根拠となった観測日時、`evidence` に結果ディレクトリを書く
 *
 * **`'unsafe-inline'` / `'unsafe-eval'` は追加しないこと**(SPEC 6)。
 * 動かないライブラリが出た場合は差し替えるか docs/OPEN_QUESTIONS.md に上げる。
 */

export interface CspVersionNote {
  readonly version: number;
  /** このバージョンを採用した日 (YYYY-MM-DD) */
  readonly adoptedOn: string;
  readonly summary: string;
  readonly changes: readonly string[];
  /** 変更の根拠となった観測日時。初版は観測に基づかないので null */
  readonly observedAt: string | null;
  /** 根拠データの置き場所(experiments/results/... )。初版は null */
  readonly evidence: string | null;
}

export const CSP_VERSION_HISTORY: readonly CspVersionNote[] = [
  {
    version: 1,
    adoptedOn: "2026-08-13",
    summary: "初版。default-src 'none' を起点に必要最小限のみ開ける設計",
    changes: [
      "default-src 'none' / object-src 'none' / base-uri 'none' / frame-ancestors 'none'",
      "script-src 'self' • style-src 'self'(nonce・ハッシュ非依存。SPEC 4.3 の方針)",
      "connect-src と form-action に Cognito のエンドポイントを追加(別オリジンのため)",
      "report-uri(後方互換)と report-to(Reporting API)を併記",
    ],
    observedAt: null,
    evidence: null,
  },
];

export const CSP_CURRENT_VERSION = 1;

/** Reporting-Endpoints ヘッダで宣言するグループ名 */
export const CSP_REPORT_GROUP = "csp-endpoint";
/** CloudFront の /api/* ビヘイビア経由で CSP コレクタに届くパス */
export const CSP_REPORT_PATH = "/api/csp-report";

export interface CspInputs {
  /** Cognito のリージョン(cognito-idp エンドポイントの組み立てに使う) */
  readonly region: string;
  /** Managed Login のドメイン。例: my-pool.auth.ap-northeast-1.amazoncognito.com */
  readonly cognitoDomain: string;
  /** true のとき require-trusted-types-for / trusted-types を追加 */
  readonly trustedTypes: boolean;
}

export type CspDirectives = readonly (readonly [string, readonly string[]])[];

export function buildCspDirectives(inputs: CspInputs): CspDirectives {
  const cognitoIdp = `https://cognito-idp.${inputs.region}.amazonaws.com`;
  const cognitoHosted = `https://${inputs.cognitoDomain}`;

  const directives: (readonly [string, readonly string[]])[] = [
    ["default-src", ["'none'"]],
    ["script-src", ["'self'"]],
    ["style-src", ["'self'"]],
    ["img-src", ["'self'", "data:"]],
    ["font-src", ["'self'"]],
    // Cognito は自ディストリビューションとは別オリジンなので明示が必要
    ["connect-src", ["'self'", cognitoIdp, cognitoHosted]],
    // Managed Login へのリダイレクト(フォーム送信)を許可する
    ["form-action", ["'self'", cognitoHosted]],
    ["frame-ancestors", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["object-src", ["'none'"]],
    ["upgrade-insecure-requests", []],
    ["report-uri", [CSP_REPORT_PATH]],
    ["report-to", [CSP_REPORT_GROUP]],
  ];

  if (inputs.trustedTypes) {
    directives.push(["require-trusted-types-for", ["'script'"]]);
    directives.push(["trusted-types", ["default"]]);
  }

  return directives;
}

export function serializeCsp(directives: CspDirectives): string {
  return directives
    .map(([name, values]) => (values.length === 0 ? name : `${name} ${values.join(" ")}`))
    .join("; ");
}

export function buildCspHeaderValue(inputs: CspInputs): string {
  const value = serializeCsp(buildCspDirectives(inputs));
  assertNoUnsafeSources(value);
  return value;
}

/**
 * `'unsafe-inline'` / `'unsafe-eval'` の混入を synth 時に落とすためのガード。
 * 「動かないから足す」を機械的に禁止する(SPEC 6)。
 */
export function assertNoUnsafeSources(csp: string): void {
  const forbidden = ["'unsafe-inline'", "'unsafe-eval'"];
  const found = forbidden.filter((token) => csp.includes(token));
  if (found.length > 0) {
    throw new Error(
      `CSP に ${found.join(" / ")} が含まれています。SPEC 4.3 により禁止です。` +
        "原因のライブラリを差し替えるか docs/OPEN_QUESTIONS.md に上げてください。",
    );
  }
}
