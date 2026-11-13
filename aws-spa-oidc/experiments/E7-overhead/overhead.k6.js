/**
 * 実験 E7: hardened / baseline のレイテンシ比較(k6)。
 *
 * 同一コンテンツ・同一時刻に両方へ同じ負荷をかけ、WAF とセキュリティヘッダの
 * オーバーヘッドを p50 / p95 / p99 で見る。時系列 before/after にすると
 * ネットワーク状況が交絡するため、必ず同時に測る(SPEC 2.1)。
 *
 * 実行は experiments/E7-overhead/run.mjs 経由。環境変数で条件を受け取る:
 *   HARDENED_URL, BASELINE_URL, VUS, DURATION_SECONDS, TARGET_PATH
 */

import http from "k6/http";
import { Trend } from "k6/metrics";
import { check, sleep } from "k6";

const hardenedUrl = __ENV.HARDENED_URL;
const baselineUrl = __ENV.BASELINE_URL;
const targetPath = __ENV.TARGET_PATH || "/";

const hardenedLatency = new Trend("hardened_latency", true);
const baselineLatency = new Trend("baseline_latency", true);

export const options = {
  // 同時実行数と実行時間は run.mjs が安全弁を通した値を渡す
  vus: Number(__ENV.VUS || 5),
  duration: `${Number(__ENV.DURATION_SECONDS || 60)}s`,
  thresholds: {
    // 閾値は「失敗させる」ためではなく、結果に必ず現れるようにするために置く
    hardened_latency: ["p(99)>=0"],
    baseline_latency: ["p(99)>=0"],
  },
};

export default function () {
  const hardened = http.get(`${hardenedUrl}${targetPath}`, { tags: { target: "hardened" } });
  hardenedLatency.add(hardened.timings.duration);
  check(hardened, { "hardened: 2xx/3xx": (r) => r.status < 400 });

  if (baselineUrl) {
    const baseline = http.get(`${baselineUrl}${targetPath}`, { tags: { target: "baseline" } });
    baselineLatency.add(baseline.timings.duration);
    check(baseline, { "baseline: 2xx/3xx": (r) => r.status < 400 });
  }

  // レート制限に当たらないよう間隔を空ける(この実験の対象は WAF のブロックではない)
  sleep(1);
}
