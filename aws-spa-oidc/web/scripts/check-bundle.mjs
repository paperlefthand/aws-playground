/**
 * ビルド成果物の JS を検査する純粋関数。
 * `vp run verify:bundle` / `vp run verify:vuln-mode` と Vitest から使う。
 *
 * SPEC 1 の禁止事項:
 *   - `eval` / `new Function` を使うライブラリ(CSP から `'unsafe-eval'` を
 *     外せなくなるため)
 * SPEC 4.6:
 *   - `vulnMode=false` のビルドに検証用ページが含まれないこと
 */

/**
 * `'unsafe-eval'` を要求することになる実行時 API の呼び出しを探す。
 * 識別子の一部(`retrieval(` など)を拾わないよう単語境界で見る。
 */
const FORBIDDEN_PATTERNS = [
  { name: "eval()", regex: /(?<![.\w$])eval\s*\(/g },
  { name: "new Function()", regex: /(?<![.\w$])new\s+Function\s*\(/g },
];

/**
 * @param {string} js
 * @returns {{ name: string; count: number; sample: string }[]}
 */
export function findForbiddenRuntimeApis(js) {
  const findings = [];
  for (const { name, regex } of FORBIDDEN_PATTERNS) {
    const matches = [...js.matchAll(regex)];
    if (matches.length > 0) {
      const at = matches[0].index ?? 0;
      findings.push({
        name,
        count: matches.length,
        sample: js.slice(Math.max(0, at - 40), at + 40).replaceAll(/\s+/g, " "),
      });
    }
  }
  return findings;
}

/** @param {string} js @param {string} marker */
export function containsMarker(js, marker) {
  return js.includes(marker);
}
