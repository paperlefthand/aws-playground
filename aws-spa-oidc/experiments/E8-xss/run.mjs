/**
 * 実験 E8: vulnMode のページにペイロードを注入し、CSP の有無で
 * 「外部ドメインへの情報送信が成立するか」を比較する。
 *
 *   node experiments/E8-xss/run.mjs [--outputs=infra/cdk-outputs.json]
 *
 * 前提:
 *   - `vp run gen:env --vuln-mode` → `vp build` → S3 へ配置(RUNBOOK 参照)。
 *     vulnMode を含まないビルドでは /lab/search が 404 になり測定できない。
 *   - Playwright が必要(`npx playwright install chromium`)。
 *
 * ペイロードの送信先は存在しないホスト(*.invalid)。第三者のサイトへは飛ばさない。
 */

import { exit } from "node:process";
import { parseArgs } from "../lib/cli.mjs";
import { createWriter } from "../lib/results.mjs";
import { assertAllowedTarget, loadTargets, requireBaseline } from "../lib/targets.mjs";
import { PAYLOADS, compareTargets, evaluateObservation, toQueryValue } from "./payloads.mjs";

const { values } = parseArgs(process.argv.slice(2));
const targets = loadTargets(values.outputs);
const baselineUrl = requireBaseline(targets);

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error(
    "E8: playwright が見つかりません。次を実行してください:\n" +
      "  vp -C experiments add -D playwright && npx playwright install chromium",
  );
  exit(2);
}

/**
 * 1 ペイロードをブラウザで開き、発生したリクエストとコンソールエラーを記録する。
 */
async function observe(browser, baseUrl, payload, targetLabel) {
  const url = `${baseUrl}/lab/search?q=${toQueryValue(payload)}`;
  assertAllowedTarget(url, targets.allowedHosts);

  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  const consoleErrors = [];

  // CSP に止められたリクエストも requestfailed 経由で観測できる
  page.on("request", (request) => requests.push(request.url()));
  page.on("requestfailed", (request) => requests.push(request.url()));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    // 非同期に飛ぶ送信を拾うための待ち
    await page.waitForTimeout(2000);
  } finally {
    await context.close();
  }

  return { payloadId: payload.id, target: targetLabel, url, requests, consoleErrors };
}

const browser = await chromium.launch();
const writer = createWriter("E8-xss");
const observations = [];

try {
  for (const [label, baseUrl] of [
    ["hardened", targets.hardenedUrl],
    ["baseline", baselineUrl],
  ]) {
    for (const payload of PAYLOADS) {
      console.log(`E8: ${label} / ${payload.id}`);
      observations.push(await observe(browser, baseUrl, payload, label));
    }
  }
} finally {
  await browser.close();
}

const rows = observations.map(evaluateObservation);
const comparison = compareTargets(rows);

writer.raw("observations.json", observations);
writer.csv("results.csv", rows, [
  "payload",
  "target",
  "exfiltration_succeeded",
  "csp_violation_logged",
  "console_errors",
]);
writer.csv("comparison.csv", comparison);
writer.metadata({
  hardenedUrl: targets.hardenedUrl,
  baselineUrl,
  payloads: PAYLOADS.map((payload) => ({ id: payload.id, description: payload.description })),
  note: "vulnMode を含むビルドが配置されていること。/lab/search が 404 なら測定は無効。",
});

console.log("E8: CSP による遮断(1 = baseline で成立し hardened で止まった)");
for (const row of comparison) {
  console.log(`  ${row.payload}: ${row.blocked_by_csp}`);
}
console.log(`E8: 出力 → ${writer.dir}`);
