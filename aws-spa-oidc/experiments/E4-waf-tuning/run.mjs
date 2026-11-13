/**
 * 実験 E4: Athena で WAF ログを分析する。
 *
 *   # 1) 集計とラベル付け用 CSV の生成
 *   node experiments/E4-waf-tuning/run.mjs --database=edge_lab_waf_logs \
 *     --workgroup=edge-lab-waf-analysis [--table=edge_waf_logs] [--date=2026-08-14]
 *
 *   # 2) 人が labeling.csv の verdict 列を埋めたあと、誤検知率を計算
 *   node experiments/E4-waf-tuning/run.mjs --labeled=experiments/results/E4-waf-tuning/<ts>/labeling.csv
 *
 * 誤検知率は人の判断が要るので 2 段階に分けている(analyze.mjs のコメント参照)。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { exit } from "node:process";
import { parseArgs } from "../lib/cli.mjs";
import { parseCsv } from "../lib/parse-csv.mjs";
import { createWriter } from "../lib/results.mjs";
import {
  computeFalsePositiveRates,
  toLabelingRows,
  toRuleHitRows,
  validateLabels,
} from "./analyze.mjs";

const { values } = parseArgs(process.argv.slice(2));

// --- 第 2 段階: ラベル付け済み CSV から誤検知率を出す ---
if (values.labeled) {
  const labeled = parseCsv(readFileSync(values.labeled, "utf8"));
  const problems = validateLabels(labeled);
  if (problems.length > 0) {
    console.error(`E4: labeling.csv に問題があります:\n  ${problems.join("\n  ")}`);
    exit(1);
  }

  const rates = computeFalsePositiveRates(labeled);
  const writer = createWriter("E4-waf-tuning");
  writer.raw("labeling-input.csv", readFileSync(values.labeled, "utf8"));
  writer.csv("false-positive-rates.csv", rates, [
    "rule",
    "legitimate",
    "attack",
    "unlabeled",
    "judged",
    "false_positive_rate",
  ]);
  writer.metadata({ stage: "false-positive-rate", source: path.resolve(values.labeled) });

  console.log("E4: ルール別の誤検知率");
  for (const row of rates) {
    const rate =
      row.false_positive_rate === ""
        ? "(未判定)"
        : `${(row.false_positive_rate * 100).toFixed(1)}%`;
    console.log(`  ${row.rule}: ${rate} (判定済み ${row.judged} / 未判定 ${row.unlabeled})`);
  }
  console.log(`E4: 出力 → ${writer.dir}`);
  exit(0);
}

// --- 第 1 段階: Athena で集計してラベル付け用 CSV を作る ---
const database = values.database;
const workgroup = values.workgroup;
const table = values.table ?? "edge_waf_logs";
const date = values.date ?? new Date().toISOString().slice(0, 10);

if (!database || !workgroup) {
  console.error(
    "usage: node experiments/E4-waf-tuning/run.mjs --database=<glue db> --workgroup=<athena wg> " +
      "[--table=edge_waf_logs] [--date=YYYY-MM-DD]\n" +
      "   or: node experiments/E4-waf-tuning/run.mjs --labeled=<labeling.csv>",
  );
  exit(2);
}

const [year, month, day] = date.split("-");
if (!year || !month || !day) {
  console.error(`--date は YYYY-MM-DD で指定してください(指定値: ${date})`);
  exit(2);
}

const queries = loadQueries(path.join(import.meta.dirname, "queries.sql"), {
  table: `"${database}"."${table}"`,
  year,
  month,
  day,
});

function aws(args) {
  return execFileSync("aws", args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
}

function runAthena(sql) {
  const executionId = JSON.parse(
    aws([
      "athena",
      "start-query-execution",
      "--query-string",
      sql,
      "--work-group",
      workgroup,
      "--query-execution-context",
      `Database=${database}`,
    ]),
  ).QueryExecutionId;

  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = JSON.parse(
      aws(["athena", "get-query-execution", "--query-execution-id", executionId]),
    ).QueryExecution.Status.State;
    if (state === "SUCCEEDED") {
      return toObjects(
        JSON.parse(aws(["athena", "get-query-results", "--query-execution-id", executionId])),
      );
    }
    if (state === "FAILED" || state === "CANCELLED") {
      throw new Error(`Athena クエリが ${state} になりました (${executionId})`);
    }
    execFileSync("sleep", ["2"]);
  }
  throw new Error(`Athena クエリが完了しませんでした (${executionId})`);
}

const writer = createWriter("E4-waf-tuning");

const ruleHits = toRuleHitRows(runAthena(queries.rule_hits));
const samples = runAthena(queries.counted_samples);
const blocked = runAthena(queries.blocked_requests);

writer.raw("rule-hits.json", ruleHits);
writer.raw("counted-samples.json", samples);
writer.csv("rule-hits.csv", ruleHits, ["rule", "action", "hits"]);
writer.csv("blocked-requests.csv", blocked);
// verdict 列は空。人が埋めてから第 2 段階を実行する
writer.csv("labeling.csv", toLabelingRows(ruleHits, samples), [
  "rule",
  "action",
  "uri",
  "client_ip",
  "country",
  "user_agent",
  "verdict",
  "note",
]);
writer.metadata({ stage: "collect", database, workgroup, table, date, queries });

console.log(`E4: ルール別ヒット数 ${ruleHits.length} 件、Count のサンプル ${samples.length} 件`);
console.log(`E4: 出力 → ${writer.dir}`);
console.log(
  `E4: 次に ${path.join(writer.dir, "labeling.csv")} の verdict 列を埋めてから、\n` +
    `    node experiments/E4-waf-tuning/run.mjs --labeled=${path.join(writer.dir, "labeling.csv")}`,
);

/** queries.sql を `-- name:` 単位に分割し、`${...}` を差し込む */
function loadQueries(file, params) {
  const text = readFileSync(file, "utf8");
  const result = {};
  let name;
  let buffer = [];

  const flush = () => {
    if (name) {
      result[name] = buffer.join("\n").trim();
    }
    buffer = [];
  };

  for (const line of text.split("\n")) {
    const match = /^--\s*name:\s*(\S+)/.exec(line);
    if (match) {
      flush();
      name = match[1];
      continue;
    }
    if (name && !line.startsWith("--")) {
      buffer.push(line);
    }
  }
  flush();

  for (const key of Object.keys(result)) {
    result[key] = result[key].replaceAll(/\$\{(\w+)\}/g, (_, param) => {
      if (!(param in params)) {
        throw new Error(`queries.sql の \${${param}} に対応する値がありません`);
      }
      return params[param];
    });
  }
  return result;
}

/** Athena の GetQueryResults を素直なオブジェクト配列にする */
function toObjects(payload) {
  const rows = payload?.ResultSet?.Rows ?? [];
  if (rows.length === 0) {
    return [];
  }
  const header = (rows[0].Data ?? []).map((cell) => cell.VarCharValue ?? "");
  return rows
    .slice(1)
    .map((row) =>
      Object.fromEntries(header.map((key, index) => [key, row.Data?.[index]?.VarCharValue ?? ""])),
    );
}
