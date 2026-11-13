/**
 * レートベースルールの「発火までの試行回数」と「回復時間」を測る共通処理
 * (実験 E5 / E6)。
 *
 * 安全弁(SPEC 4.7):
 *   - 対象は `assertAllowedTarget` を通したホストのみ(labFetch が強制)
 *   - レートは `resolveLoadProfile` の既定値で低く固定。上げるには明示フラグ
 *   - 総試行回数にも上限を置き、暴走しても止まる
 */

import { labFetch } from "./http.mjs";
import { intervalMsFor, sleep } from "./safety.mjs";
import { isUnmarkedForbidden, isWafBlock } from "./waf.mjs";

/** 明示フラグを付けても超えない総試行回数の上限 */
export const HARD_MAX_ATTEMPTS = 5000;

/**
 * ブロックが出るまで一定レートで叩く。
 *
 * @param {{ urlFor: (attempt: number) => string, allowedHosts: Set<string>,
 *           rps: number, maxAttempts: number, method?: string,
 *           headers?: Record<string,string>, body?: string,
 *           onProgress?: (record: object) => void }} options
 */
export async function probeUntilBlocked(options) {
  const maxAttempts = Math.min(options.maxAttempts, HARD_MAX_ATTEMPTS);
  const interval = intervalMsFor(options.rps);
  const records = [];
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await labFetch(options.urlFor(attempt), {
      allowedHosts: options.allowedHosts,
      method: options.method,
      headers: options.headers,
      body: options.body,
    });

    const record = {
      attempt,
      elapsedMs: Date.now() - startedAt,
      status: result.status,
      latencyMs: result.elapsedMs,
      wafBlocked: isWafBlock(result),
      unmarkedForbidden: isUnmarkedForbidden(result),
    };
    records.push(record);
    options.onProgress?.(record);

    if (record.wafBlocked) {
      break;
    }
    await sleep(interval);
  }

  return records;
}

/**
 * ブロックが解けるまで低レートで叩き続け、回復までの時間を測る。
 *
 * @param {{ url: string, allowedHosts: Set<string>, intervalMs?: number,
 *           timeoutMs?: number }} options
 */
export async function probeUntilRecovered(options) {
  const interval = options.intervalMs ?? 10_000;
  const timeout = options.timeoutMs ?? 15 * 60_000;
  const records = [];
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    await sleep(interval);
    const result = await labFetch(options.url, { allowedHosts: options.allowedHosts });
    const record = {
      elapsedMs: Date.now() - startedAt,
      status: result.status,
      wafBlocked: isWafBlock(result),
    };
    records.push(record);
    if (!record.wafBlocked) {
      return { recovered: true, recoveryMs: record.elapsedMs, records };
    }
  }

  return { recovered: false, recoveryMs: null, records };
}

/**
 * 測定結果の要約。**ブロックが観測できなかった場合に数値を作らない**こと。
 *
 * @param {{ attempt: number, elapsedMs: number, wafBlocked: boolean,
 *           unmarkedForbidden: boolean }[]} records
 */
export function summarizeProbe(records) {
  const blocked = records.find((record) => record.wafBlocked);
  const unmarked = records.filter((record) => record.unmarkedForbidden).length;

  return {
    attempts: records.length,
    // 未観測は null。0 や最大値で埋めない(SPEC 6)
    attemptsUntilBlocked: blocked ? blocked.attempt : null,
    timeToBlockMs: blocked ? blocked.elapsedMs : null,
    blocked: Boolean(blocked),
    // 403 だが WAF の印が無いもの。オリジン由来か経路の違いを疑う材料
    unmarkedForbiddenCount: unmarked,
    note: blocked
      ? null
      : "上限まで試行してもブロックを観測できませんでした。閾値がレートより高い可能性があります(--rps か --max-attempts を見直してください)。",
  };
}
