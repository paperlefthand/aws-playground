/**
 * 実験結果の出力先(SPEC 4.7)。
 *
 * すべての実験を「実行 → `experiments/results/<experiment-id>/<timestamp>/` に
 * 生データと集計 CSV/JSON を出力」に統一する。レポートの図表はこの CSV から作る。
 * 生データもコミットするので、後から集計をやり直せる。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { toCsv } from "./csv.mjs";

export const RESULTS_ROOT = "experiments/results";

/**
 * ディレクトリ名に使えるタイムスタンプ。ISO 8601 からコロンだけ落とす
 * (辞書順 = 時系列順になるので並べ替えが要らない)。
 *
 * @param {Date} [now]
 */
export function timestampDir(now = new Date()) {
  return now
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d+Z$/, "Z");
}

/**
 * @param {string} experimentId 例: "E2-headers"
 * @param {{ now?: Date, root?: string }} [options]
 */
export function createResultDir(experimentId, options = {}) {
  const dir = path.join(
    options.root ?? RESULTS_ROOT,
    experimentId,
    timestampDir(options.now ?? new Date()),
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 実験結果の書き出し口。生データと集計を必ず同じディレクトリに置く。
 */
export function createWriter(experimentId, options = {}) {
  const dir = createResultDir(experimentId, options);
  const written = [];

  const write = (name, content) => {
    const target = path.join(dir, name);
    writeFileSync(target, content, "utf8");
    written.push(target);
    return target;
  };

  return {
    dir,
    written,
    /** 生データ(取得したそのまま)。後から集計をやり直せるように必ず残す */
    raw: (name, content) => write(name, typeof content === "string" ? content : json(content)),
    json: (name, value) => write(name, json(value)),
    csv: (name, rows, columns) => write(name, toCsv(rows, columns)),
    /** 実行条件のメモ。何をどう測ったかが分からない結果を残さないため */
    metadata: (value) =>
      write(
        "metadata.json",
        json({ experimentId, recordedAt: new Date().toISOString(), ...value }),
      ),
  };
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
