/**
 * ビルド後の HTML に inline <script> / <style> が無いことを検査する純粋関数。
 * CSP `script-src 'self'` / `style-src 'self'`(SPEC 4.3)の前提条件で、
 * `vp run verify:no-inline` と Vitest の両方から使う。
 */

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const STYLE_RE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;

/**
 * @param {string} html
 * @returns {{ kind: "inline-script" | "inline-style"; snippet: string }[]}
 */
export function findInlineViolations(html) {
  const violations = [];

  for (const match of html.matchAll(SCRIPT_RE)) {
    const [tag, attrs, body] = match;
    const hasSrc = /\bsrc\s*=/i.test(attrs);
    if (!hasSrc && body.trim() !== "") {
      violations.push({ kind: "inline-script", snippet: truncate(tag) });
    }
  }

  for (const match of html.matchAll(STYLE_RE)) {
    violations.push({ kind: "inline-style", snippet: truncate(match[0]) });
  }

  return violations;
}

/** @param {string} text */
function truncate(text) {
  const oneLine = text.replaceAll(/\s+/g, " ");
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}
