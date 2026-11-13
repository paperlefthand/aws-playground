/**
 * 実験 E3: CloudWatch Logs Insights から CSP 違反を集計する。
 *
 *   node experiments/E3-csp/run.mjs --log-group=/aws/lambda/... [--hours=24]
 *
 * ロググループ名は CDK 出力に無いため、`aws logs describe-log-groups` などで
 * 調べて渡す(RUNBOOK に手順を書く)。AWS 資格情報は環境変数か
 * `~/.aws/credentials` から取る。
 */

import { execFileSync } from "node:child_process";
import { exit } from "node:process";
import { parseArgs } from "../lib/cli.mjs";
import { createWriter } from "../lib/results.mjs";
import { parseInsightsRows, summarize } from "./aggregate.mjs";

const { values } = parseArgs(process.argv.slice(2));
const logGroup = values["log-group"];
const hours = Number(values.hours ?? 24);

if (!logGroup) {
  console.error(
    "usage: node experiments/E3-csp/run.mjs --log-group=<CSP コレクタのロググループ> [--hours=24]",
  );
  exit(2);
}
if (!Number.isFinite(hours) || hours <= 0) {
  console.error(`--hours は正の数で指定してください(指定値: ${values.hours})`);
  exit(2);
}

const QUERY = [
  "fields @timestamp, @message",
  "| filter kind = 'csp-violation'",
  "| sort @timestamp desc",
  "| limit 10000",
].join("\n");

const endTime = Math.floor(Date.now() / 1000);
const startTime = endTime - Math.round(hours * 3600);

function aws(args) {
  return execFileSync("aws", args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
}

let queryId;
try {
  queryId = JSON.parse(
    aws([
      "logs",
      "start-query",
      "--log-group-name",
      logGroup,
      "--start-time",
      String(startTime),
      "--end-time",
      String(endTime),
      "--query-string",
      QUERY,
    ]),
  ).queryId;
} catch {
  console.error(
    "E3: Logs Insights のクエリを開始できませんでした。AWS CLI と資格情報、" +
      "ロググループ名を確認してください。",
  );
  exit(1);
}

// Insights は非同期。完了までポーリングする
let result;
for (let attempt = 0; attempt < 60; attempt += 1) {
  result = JSON.parse(aws(["logs", "get-query-results", "--query-id", queryId]));
  if (result.status !== "Running" && result.status !== "Scheduled") {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

if (result?.status !== "Complete") {
  console.error(`E3: クエリが完了しませんでした (status=${result?.status})`);
  exit(1);
}

const records = parseInsightsRows(result.results);
const summary = summarize(records);

const writer = createWriter("E3-csp");
writer.raw("insights-results.json", result);
writer.csv("violations.csv", summary.rows, [
  "effective_directive",
  "blocked_uri",
  "count",
  "sample_document_uri",
  "sample_script",
]);
writer.json("summary.json", {
  totalViolations: summary.totalViolations,
  distinctPairs: summary.distinctPairs,
  zeroViolationCaveat: summary.zeroViolationCaveat,
});
writer.metadata({ logGroup, hours, query: QUERY, startTime, endTime });

console.log(`E3: 違反 ${summary.totalViolations} 件 / ${summary.distinctPairs} 種類`);
if (summary.zeroViolationCaveat) {
  console.warn(`E3: ${summary.zeroViolationCaveat}`);
}
console.log(`E3: 出力 → ${writer.dir}`);
