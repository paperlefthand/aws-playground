/**
 * 実験 E2: レスポンスヘッダの取得と採点。
 *
 *   node experiments/E2-headers/run.mjs [--outputs=infra/cdk-outputs.json]
 *
 * hardened / baseline の両方に同じリクエストを投げ、`experiments/E2-headers/rubric.mjs`
 * のルーブリックで採点する。生ヘッダも残すので、後からルーブリックを変えて
 * 採点し直せる。
 *
 * 外部採点サービスのスコアは CSV の空欄に手で記録する(SPEC 6: 未取得の値を
 * 想像で埋めない)。
 */

import { parseArgs } from "../lib/cli.mjs";
import { labFetch } from "../lib/http.mjs";
import { createWriter } from "../lib/results.mjs";
import { loadTargets } from "../lib/targets.mjs";
import { scoreHeaders, toComparisonRows } from "./rubric.mjs";

const { values } = parseArgs(process.argv.slice(2));
const targets = loadTargets(values.outputs);

/** SPA のルート。CloudFront Function で index.html に書き換えられる */
const PATHS = ["/", "/protected", "/assets/"];

async function probe(baseUrl) {
  const results = [];
  for (const path of PATHS) {
    const result = await labFetch(new URL(path, baseUrl).toString(), {
      allowedHosts: targets.allowedHosts,
    });
    results.push({
      path,
      status: result.status,
      headers: result.headers,
      elapsedMs: result.elapsedMs,
    });
  }
  return results;
}

const writer = createWriter("E2-headers");

const hardenedRaw = await probe(targets.hardenedUrl);
const baselineRaw = targets.baselineUrl ? await probe(targets.baselineUrl) : undefined;

// 採点はトップページの応答で行う(ヘッダはビヘイビア単位で付くため)
const hardened = scoreHeaders(hardenedRaw[0].headers);
const baseline = baselineRaw ? scoreHeaders(baselineRaw[0].headers) : undefined;

writer.raw("hardened-headers.json", { url: targets.hardenedUrl, probes: hardenedRaw });
if (baselineRaw) {
  writer.raw("baseline-headers.json", { url: targets.baselineUrl, probes: baselineRaw });
}

writer.csv("rubric.csv", toComparisonRows(hardened, baseline), [
  "id",
  "description",
  "hardened_pass",
  "hardened_value",
  "baseline_pass",
  "baseline_value",
]);

// 外部採点サービスのスコアを手で記録する欄。値は空のまま出す
writer.csv(
  "external-scores.csv",
  [
    {
      target: "hardened",
      url: targets.hardenedUrl,
      service: "",
      grade: "",
      score: "",
      measured_at: "",
    },
    {
      target: "baseline",
      url: targets.baselineUrl ?? "",
      service: "",
      grade: "",
      score: "",
      measured_at: "",
    },
  ],
  ["target", "url", "service", "grade", "score", "measured_at"],
);

writer.json("summary.json", {
  hardened: {
    url: targets.hardenedUrl,
    passed: hardened.passed,
    total: hardened.total,
    cspMode: hardened.cspMode,
  },
  baseline: baseline
    ? {
        url: targets.baselineUrl,
        passed: baseline.passed,
        total: baseline.total,
        cspMode: baseline.cspMode,
      }
    : null,
});

writer.metadata({
  paths: PATHS,
  hardenedUrl: targets.hardenedUrl,
  baselineUrl: targets.baselineUrl ?? null,
});

console.log(`E2: hardened ${hardened.passed}/${hardened.total} (csp=${hardened.cspMode})`);
if (baseline) {
  console.log(`E2: baseline ${baseline.passed}/${baseline.total} (csp=${baseline.cspMode})`);
}
console.log(`E2: 出力 → ${writer.dir}`);
