/**
 * `unknown` を表示用の文字列にする。
 * オブジェクトが `[object Object]` になるのを避け、JSON にして情報を残す。
 */

/** @param {unknown} value */
export function text(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
