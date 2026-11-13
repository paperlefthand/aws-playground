/**
 * 負荷を伴う実験(E5 / E6 / E7)の安全弁(SPEC 4.7)。
 *
 * AWS の侵入テストポリシー上、DoS / DDoS に相当する負荷試験は事前承認が必要。
 * ここで扱うのは「レート制限が発火することを確認する」ために必要な最小限の
 * レートであり、既定値は低く固定してある。引き上げるには明示フラグが要る。
 */

/** 既定の上限。レート制限の発火確認にはこれで足りる */
export const DEFAULT_MAX_RPS = 10;
export const DEFAULT_MAX_VUS = 5;
export const DEFAULT_DURATION_SECONDS = 60;

/** 明示フラグを付けても超えられない絶対上限 */
export const HARD_MAX_RPS = 200;
export const HARD_MAX_VUS = 50;
export const HARD_MAX_DURATION_SECONDS = 900;

/** 明示フラグの名前。README / RUNBOOK と一致させること */
export const ACK_FLAG = "--i-have-load-test-approval";

export const AWS_POLICY_NOTICE = [
  "AWS の侵入テストポリシー上、DoS / DDoS に相当する負荷試験は事前承認が必要です。",
  "本スクリプトはレート制限の発火を確認するのに必要な最小限のレートに留めています。",
  `既定を超えるレートを指定するには ${ACK_FLAG} が必要です。`,
].join("\n");

/**
 * 負荷プロファイルを決める。既定を超える指定は明示フラグが無ければ拒否する。
 *
 * @param {{ rps?: number, vus?: number, durationSeconds?: number, approved?: boolean }} requested
 */
export function resolveLoadProfile(requested = {}) {
  const rps = requested.rps ?? DEFAULT_MAX_RPS;
  const vus = requested.vus ?? DEFAULT_MAX_VUS;
  const durationSeconds = requested.durationSeconds ?? DEFAULT_DURATION_SECONDS;
  const approved = requested.approved === true;

  for (const [name, value] of Object.entries({ rps, vus, durationSeconds })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} は正の数で指定してください(指定値: ${String(value)})`);
    }
  }

  const defaults = {
    rps: DEFAULT_MAX_RPS,
    vus: DEFAULT_MAX_VUS,
    durationSeconds: DEFAULT_DURATION_SECONDS,
  };
  const hardMax = {
    rps: HARD_MAX_RPS,
    vus: HARD_MAX_VUS,
    durationSeconds: HARD_MAX_DURATION_SECONDS,
  };

  for (const [name, value] of Object.entries({ rps, vus, durationSeconds })) {
    if (value > defaults[name] && !approved) {
      throw new Error(
        `${name}=${value} は既定の上限 ${defaults[name]} を超えています。\n${AWS_POLICY_NOTICE}`,
      );
    }
    if (value > hardMax[name]) {
      throw new Error(
        `${name}=${value} は絶対上限 ${hardMax[name]} を超えています。${ACK_FLAG} を付けても実行できません。`,
      );
    }
  }

  return { rps, vus, durationSeconds, approved };
}

/**
 * 逐次リクエストの間隔(ミリ秒)。RPS を守るために使う。
 * @param {number} rps
 */
export function intervalMsFor(rps) {
  return Math.ceil(1000 / rps);
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
