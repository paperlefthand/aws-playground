/**
 * 人が編集した CSV(E4 のラベル付けファイル)を読むための最小パーサ。
 * 引用符とその中の改行・カンマを扱う。
 */

/**
 * @param {string} text
 * @returns {Record<string, string>[]}
 */
export function parseCsv(text) {
  const rows = parseRows(text);
  if (rows.length === 0) {
    return [];
  }
  const header = rows[0];
  return (
    rows
      .slice(1)
      // 末尾の空行を落とす
      .filter((row) => row.some((cell) => cell !== ""))
      .map((row) => Object.fromEntries(header.map((key, index) => [key, row[index] ?? ""])))
  );
}

/** @param {string} text */
export function parseRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
