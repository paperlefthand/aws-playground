/**
 * 実験 E5: レートベースルールの発火閾値と回復時間を実測する。
 *
 *   node experiments/E5-rate/run.mjs [--rps=10] [--max-attempts=600] [--path=/api/csp-report]
 *
 * SPEC 4.7 の安全弁:
 *   - 対象は CDK 出力にあるホストのみ(experiments/lib/targets.mjs)
 *   - RPS / 同時実行数の既定値は低く固定。超えるには明示フラグが要る
 *   - 総試行回数にも上限がある
 *
 * SPEC は E5 に k6 を挙げているが、ここでは Node で実装している。測りたいのが
 * スループットではなく「何回目でブロックされたか」という **逐次の回数** であり、
 * レート上限・総試行上限・ホワイトリストをプロセス内で強制できるほうが
 * 安全弁として確実なため。負荷とレイテンシの測定(E7)には k6 を使う。
 */

import { exit } from "node:process";
import { optionalNumber, parseLoadOptions } from "../lib/cli.mjs";
import { probeUntilBlocked, probeUntilRecovered, summarizeProbe } from "../lib/rate-probe.mjs";
import { createWriter } from "../lib/results.mjs";
import { AWS_POLICY_NOTICE, resolveLoadProfile } from "../lib/safety.mjs";
import { loadTargets } from "../lib/targets.mjs";

const { values, load } = parseLoadOptions(process.argv.slice(2));

let profile;
try {
  profile = resolveLoadProfile(load);
} catch (error) {
  console.error(`E5: ${error.message}`);
  exit(2);
}

const targets = loadTargets(values.outputs);
const maxAttempts = optionalNumber(values, "max-attempts") ?? 600;
// 既定は /api/* (閾値が低いほうのルール)。全パス側を試すなら --path=/
const probePath = values.path ?? "/api/csp-report";

console.log(AWS_POLICY_NOTICE);
console.log(
  `E5: ${targets.hardenedUrl}${probePath} に ${profile.rps} rps で最大 ${maxAttempts} 回`,
);

const writer = createWriter("E5-rate");
const target = new URL(probePath, targets.hardenedUrl).toString();

const attempts = await probeUntilBlocked({
  // クエリを変えてキャッシュヒットを避ける(WAF まで届かないと計測にならない)
  urlFor: (attempt) => `${target}${target.includes("?") ? "&" : "?"}e5=${attempt}`,
  allowedHosts: targets.allowedHosts,
  rps: profile.rps,
  maxAttempts,
  onProgress: (record) => {
    if (record.attempt % 50 === 0 || record.wafBlocked) {
      console.log(`  attempt=${record.attempt} status=${record.status} waf=${record.wafBlocked}`);
    }
  },
});

const summary = summarizeProbe(attempts);
console.log(
  summary.blocked
    ? `E5: ${summary.attemptsUntilBlocked} 回目でブロック(${summary.timeToBlockMs} ms)`
    : `E5: ${summary.note}`,
);

let recovery = { recovered: null, recoveryMs: null, records: [] };
if (summary.blocked) {
  console.log("E5: 回復を待ちます(10 秒間隔で確認)…");
  recovery = await probeUntilRecovered({ url: target, allowedHosts: targets.allowedHosts });
  console.log(
    recovery.recovered
      ? `E5: ${Math.round(recovery.recoveryMs / 1000)} 秒後に回復`
      : "E5: 制限時間内に回復を観測できませんでした",
  );
}

writer.raw("attempts.json", attempts);
writer.raw("recovery.json", recovery.records);
writer.csv("attempts.csv", attempts, [
  "attempt",
  "elapsedMs",
  "status",
  "latencyMs",
  "wafBlocked",
  "unmarkedForbidden",
]);
writer.json("summary.json", {
  ...summary,
  recovered: recovery.recovered,
  recoveryMs: recovery.recoveryMs,
});
writer.metadata({
  target,
  profile,
  maxAttempts,
  // 閾値は CDK context の rateLimitAll / rateLimitApi。実測と突き合わせる
  note: "設定した閾値は infra の context (rateLimitAll / rateLimitApi) を参照",
});

console.log(`E5: 出力 → ${writer.dir}`);
