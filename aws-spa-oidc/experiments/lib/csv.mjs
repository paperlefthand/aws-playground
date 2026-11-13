import { text } from "./text.mjs";

/**
 * 集計結果を CSV にする。レポートの図表はこの CSV から作る(SPEC 4.7)。
 * 依存を増やさないため自前で書く。
 */

/**
 * @param {unknown} value
 */
export function escapeCsvValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const rendered = text(value);
  // 先頭が数式記号だと表計算ソフトが式として解釈するため無害化する
  const guarded = /^[=+\-@\t\r]/.test(rendered) ? `'${rendered}` : rendered;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/**
 * オブジェクトの配列を CSV にする。列は指定順、未指定なら全行のキーの和集合。
 *
 * @param {Record<string, unknown>[]} rows
 * @param {string[]} [columns]
 */
export function toCsv(rows, columns) {
  const header = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [header.map(escapeCsvValue).join(",")];
  for (const row of rows) {
    lines.push(header.map((column) => escapeCsvValue(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}
