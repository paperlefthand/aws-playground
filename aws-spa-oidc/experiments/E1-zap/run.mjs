/**
 * 実験 E1: OWASP ZAP baseline scan を hardened / baseline の両方に実行し、
 * リスク別アラート件数を比較する。
 *
 *   node experiments/E1-zap/run.mjs [--outputs=infra/cdk-outputs.json]
 *
 * ZAP は Docker で動かす(ローカル環境を汚さないため)。Docker が無い場合は
 * その旨を出して終了する。baseline scan は受動的スキャンのみで攻撃を行わないため、
 * AWS の侵入テストポリシー上の事前承認は不要。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { exit } from "node:process";
import { parseArgs } from "../lib/cli.mjs";
import { createWriter } from "../lib/results.mjs";
import { assertAllowedTarget, loadTargets } from "../lib/targets.mjs";
import { diffByRisk, listAlerts, summarizeZapReport } from "./summarize.mjs";

const ZAP_IMAGE = "ghcr.io/zaproxy/zaproxy:stable";

const { values } = parseArgs(process.argv.slice(2));
const targets = loadTargets(values.outputs);

function requireDocker() {
  try {
    execFileSync("docker", ["--version"], { stdio: "pipe" });
  } catch {
    console.error(
      "E1: docker が見つかりません。ZAP は Docker で実行します。" +
        "Docker Desktop / Engine をインストールしてから再実行してください。",
    );
    exit(2);
  }
}

/**
 * ZAP baseline scan を 1 対象に実行し、JSON レポートを返す。
 * ZAP は「警告があると終了コード 2」を返すので、失敗として扱わない。
 */
function runZap(targetUrl, outDir, label) {
  assertAllowedTarget(targetUrl, targets.allowedHosts);
  const reportName = `${label}-zap.json`;

  try {
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${path.resolve(outDir)}:/zap/wrk:rw`,
        ZAP_IMAGE,
        "zap-baseline.py",
        "-t",
        targetUrl,
        "-J",
        reportName,
        // 受動スキャンのみ。攻撃リクエストは投げない
        "-I",
      ],
      { stdio: "inherit" },
    );
  } catch (error) {
    // 終了コード 2 = 警告あり(正常)。それ以外は本当の失敗
    if (error?.status !== 2) {
      throw error;
    }
  }

  return JSON.parse(readFileSync(path.join(outDir, reportName), "utf8"));
}

requireDocker();

const writer = createWriter("E1-zap");

console.log(`E1: hardened をスキャンします (${targets.hardenedUrl})`);
const hardenedReport = runZap(targets.hardenedUrl, writer.dir, "hardened");
const hardenedSummary = summarizeZapReport(hardenedReport);

let baselineSummary;
if (targets.baselineUrl) {
  console.log(`E1: baseline をスキャンします (${targets.baselineUrl})`);
  const baselineReport = runZap(targets.baselineUrl, writer.dir, "baseline");
  baselineSummary = summarizeZapReport(baselineReport);
  writer.csv("alerts.csv", [
    ...listAlerts(hardenedReport, "hardened"),
    ...listAlerts(baselineReport, "baseline"),
  ]);
} else {
  writer.csv("alerts.csv", listAlerts(hardenedReport, "hardened"));
}

writer.csv("risk-summary.csv", diffByRisk(hardenedSummary, baselineSummary), [
  "risk",
  "hardened",
  "baseline",
  "reduced",
]);
writer.metadata({
  image: ZAP_IMAGE,
  hardenedUrl: targets.hardenedUrl,
  baselineUrl: targets.baselineUrl ?? null,
});

console.log(`E1: 出力 → ${writer.dir}`);
