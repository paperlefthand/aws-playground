/**
 * 実験 E7: hardened / baseline のレイテンシを同時刻に測り、
 * WAF とセキュリティヘッダのオーバーヘッドを定量化する。
 *
 *   node experiments/E7-overhead/run.mjs [--vus=5] [--duration=60] [--path=/]
 *
 * 実体は k6(overhead.k6.js)。k6 が無い場合はその旨を出して終了する。
 * 安全弁: 同時実行数と実行時間は experiments/lib/safety.mjs の既定に従い、
 * 超える場合は明示フラグが要る。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { exit } from "node:process";
import { parseLoadOptions } from "../lib/cli.mjs";
import { createWriter } from "../lib/results.mjs";
import { AWS_POLICY_NOTICE, resolveLoadProfile } from "../lib/safety.mjs";
import { assertAllowedTarget, loadTargets, requireBaseline } from "../lib/targets.mjs";
import { computeOverhead, extractLatencies } from "./summarize.mjs";

const { values, load } = parseLoadOptions(process.argv.slice(2));

let profile;
try {
  profile = resolveLoadProfile(load);
} catch (error) {
  console.error(`E7: ${error.message}`);
  exit(2);
}

const targets = loadTargets(values.outputs);
// 同時刻比較が目的なので baseline は必須
const baselineUrl = requireBaseline(targets);
assertAllowedTarget(targets.hardenedUrl, targets.allowedHosts);
assertAllowedTarget(baselineUrl, targets.allowedHosts);

try {
  execFileSync("k6", ["version"], { stdio: "pipe" });
} catch {
  console.error(
    "E7: k6 が見つかりません。https://k6.io/docs/get-started/installation/ を参照して" +
      "インストールしてから再実行してください。",
  );
  exit(2);
}

console.log(AWS_POLICY_NOTICE);

const writer = createWriter("E7-overhead");
const summaryPath = path.join(writer.dir, "k6-summary.json");
const script = path.join(import.meta.dirname, "overhead.k6.js");

execFileSync("k6", ["run", "--summary-export", summaryPath, script], {
  stdio: "inherit",
  env: {
    ...process.env,
    HARDENED_URL: targets.hardenedUrl,
    BASELINE_URL: baselineUrl,
    TARGET_PATH: values.path ?? "/",
    VUS: String(profile.vus),
    DURATION_SECONDS: String(profile.durationSeconds),
  },
});

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const latencies = extractLatencies(summary);
const overhead = computeOverhead(latencies);

writer.csv("latency.csv", latencies, ["target", "samples", "p50", "p95", "p99"]);
writer.csv("overhead.csv", overhead, [
  "percentile",
  "hardened_ms",
  "baseline_ms",
  "overhead_ms",
  "overhead_percent",
]);
writer.metadata({
  hardenedUrl: targets.hardenedUrl,
  baselineUrl,
  profile,
  targetPath: values.path ?? "/",
  // 料金は実測できないのでここには書かない。docs/COST.md を参照
  note: "コストは Cost Explorer で別途確認する(docs/COST.md)。",
});

console.log("E7: レイテンシ(ms)");
for (const row of latencies) {
  console.log(`  ${row.target}: p50=${row.p50} p95=${row.p95} p99=${row.p99}`);
}
console.log(`E7: 出力 → ${writer.dir}`);
