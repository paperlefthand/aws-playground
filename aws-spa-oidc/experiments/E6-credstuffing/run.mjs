/**
 * 実験 E6: Cognito のログイン面に対する試行を段階的に行い、
 * Cognito スコープ WebACL のレートベースルールが
 * **ブロックを開始するまでの試行回数** と **回復までの時間** を測る。
 *
 *   node experiments/E6-credstuffing/run.mjs [--rps=5] [--max-attempts=400]
 *
 * 測定設計の前提(SPEC 4.5 / docs/OPEN_QUESTIONS.md Q1):
 *   - ATP ルールグループは Cognito ユーザープールに関連付けできないため使えない。
 *     したがって「認証情報の使い回しを検知する」機能の測定ではなく、
 *     **レートベースルールの挙動** の測定になる。
 *   - Managed Login へのリクエストは body が WAF に転送されず、ユーザー名や
 *     パスワードにはマッチできない。よってこの実験では **実在しない資格情報を
 *     送る必要すらない**。ログイン面へのリクエスト数だけが評価対象になる。
 *
 * 以上より、本スクリプトは **実際のパスワード試行を行わない**。ログインページへの
 * GET を繰り返し、WAF が 403 を返し始める試行回数を測る。実在ユーザーの
 * アカウントロックやパスワード試行のログを汚さずに、測りたいものだけを測る。
 *
 * 安全弁(SPEC 4.7): 対象は CDK 出力のホストのみ、既定レートは低く固定、
 * 総試行回数に上限。
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
  // Cognito 側は閾値が低い(既定 100)ので、レートも控えめの既定にする
  profile = resolveLoadProfile({ rps: 5, ...load });
} catch (error) {
  console.error(`E6: ${error.message}`);
  exit(2);
}

const targets = loadTargets(values.outputs);
if (!targets.cognitoDomain || !targets.clientId) {
  console.error(
    "E6: CDK 出力に CognitoDomain / UserPoolClientId がありません。" +
      "CoreStack と DeliveryStack をデプロイしてください。",
  );
  exit(2);
}

const maxAttempts = optionalNumber(values, "max-attempts") ?? 400;

/**
 * Managed Login のログインページ。実際の資格情報は送らない(上のコメント参照)。
 * redirect_uri は App Client に登録済みのものと一致させる必要がある。
 */
function loginUrl(attempt) {
  const params = new URLSearchParams({
    client_id: targets.clientId,
    response_type: "code",
    scope: "openid",
    redirect_uri: `${targets.hardenedUrl}/callback`,
    // キャッシュを避けて毎回 WAF まで届かせる
    state: `e6-${attempt}`,
  });
  return `https://${targets.cognitoDomain}/login?${params.toString()}`;
}

console.log(AWS_POLICY_NOTICE);
console.log(`E6: ${targets.cognitoDomain} に ${profile.rps} rps で最大 ${maxAttempts} 回`);

const writer = createWriter("E6-credstuffing");

const attempts = await probeUntilBlocked({
  urlFor: loginUrl,
  allowedHosts: targets.allowedHosts,
  rps: profile.rps,
  maxAttempts,
  onProgress: (record) => {
    if (record.attempt % 25 === 0 || record.wafBlocked) {
      console.log(`  attempt=${record.attempt} status=${record.status} waf=${record.wafBlocked}`);
    }
  },
});

const summary = summarizeProbe(attempts);
console.log(
  summary.blocked
    ? `E6: ${summary.attemptsUntilBlocked} 回目でブロック(${summary.timeToBlockMs} ms)`
    : `E6: ${summary.note}`,
);
if (summary.unmarkedForbiddenCount > 0) {
  // Managed Login はカスタムレスポンスの本文/ヘッダが最初の 1 回しか反映されない
  console.warn(
    `E6: 識別ヘッダの無い 403 が ${summary.unmarkedForbiddenCount} 件ありました。` +
      "Managed Login ではカスタムヘッダが載らない応答があるため、WAF ログ(E4)と突き合わせてください。",
  );
}

let recovery = { recovered: null, recoveryMs: null, records: [] };
if (summary.blocked) {
  console.log("E6: 回復を待ちます(10 秒間隔で確認)…");
  recovery = await probeUntilRecovered({ url: loginUrl(0), allowedHosts: targets.allowedHosts });
  console.log(
    recovery.recovered
      ? `E6: ${Math.round(recovery.recoveryMs / 1000)} 秒後に回復`
      : "E6: 制限時間内に回復を観測できませんでした",
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
  cognitoDomain: targets.cognitoDomain,
  profile,
  maxAttempts,
  sendsCredentials: false,
  note: "パスワード試行は行わない。Managed Login は body を WAF に転送せず、評価対象は IP 単位のレートのみのため(SPEC 4.5)。",
});

console.log(`E6: 出力 → ${writer.dir}`);
