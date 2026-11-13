/**
 * 実験スクリプト共通のコマンドライン引数解析。
 * 依存を増やさないための最小実装。`--key=value` / `--flag` のみ扱う。
 */

import { ACK_FLAG } from "./safety.mjs";

/**
 * @param {string[]} argv
 * @returns {{ flags: Set<string>, values: Record<string, string> }}
 */
export function parseArgs(argv) {
  const flags = new Set();
  const values = {};

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      throw new Error(`引数は --key=value か --flag の形式で指定してください: ${arg}`);
    }
    const [key, ...rest] = arg.slice(2).split("=");
    if (rest.length === 0) {
      flags.add(`--${key}`);
    } else {
      values[key] = rest.join("=");
    }
  }

  return { flags, values };
}

/**
 * @param {Record<string, string>} values
 * @param {string} key
 */
export function optionalNumber(values, key) {
  const raw = values[key];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${key} は数値で指定してください(指定値: ${raw})`);
  }
  return value;
}

/** 負荷実験共通のオプション(SPEC 4.7 の安全弁) */
export function parseLoadOptions(argv) {
  const { flags, values } = parseArgs(argv);
  return {
    flags,
    values,
    load: {
      rps: optionalNumber(values, "rps"),
      vus: optionalNumber(values, "vus"),
      durationSeconds: optionalNumber(values, "duration"),
      approved: flags.has(ACK_FLAG),
    },
  };
}
