/**
 * 実験の対象ホストの解決とホワイトリスト検査(SPEC 4.7 の安全弁)。
 *
 * **自分のディストリビューション / ユーザープール以外には実行できないようにする。**
 * 対象は必ず CDK の出力(`infra/cdk-outputs.json`)から取り、コマンドラインで
 * 任意のホストを指定させない。타이포や取り違えで無関係なサイトに負荷をかける事故を
 * 構造的に防ぐのが目的。
 */

import { readFileSync } from "node:fs";

export const DEFAULT_OUTPUTS_PATH = "infra/cdk-outputs.json";

/**
 * CDK 出力から実験対象を組み立てる。
 * スタック名は `namePrefix` で変わるため、出力名で横断的に探す。
 *
 * @param {string} [outputsPath]
 */
export function loadTargets(outputsPath = DEFAULT_OUTPUTS_PATH) {
  let outputs;
  try {
    outputs = JSON.parse(readFileSync(outputsPath, "utf8"));
  } catch {
    throw new Error(
      `${outputsPath} を読めません。先に infra/ で次を実行してください:\n` +
        "  npx cdk deploy --all --outputs-file cdk-outputs.json",
    );
  }
  return parseTargets(outputs);
}

/**
 * @param {Record<string, Record<string, string>>} outputs
 */
export function parseTargets(outputs) {
  const find = (name) => {
    for (const stackOutputs of Object.values(outputs ?? {})) {
      const value = stackOutputs?.[name];
      if (typeof value === "string" && value !== "") {
        return value;
      }
    }
    return undefined;
  };

  const hardenedUrl = find("HardenedUrl");
  if (!hardenedUrl) {
    throw new Error("CDK 出力に HardenedUrl がありません。DeliveryStack をデプロイしてください。");
  }

  const targets = {
    hardenedUrl,
    // baselineEnabled=false でデプロイした場合は存在しない
    baselineUrl: find("BaselineUrl"),
    cognitoDomain: find("CognitoDomain"),
    userPoolId: find("UserPoolId"),
    clientId: find("UserPoolClientId"),
    region: find("Region"),
    cspApiEndpoint: find("CspReportApiEndpoint"),
  };

  return { ...targets, allowedHosts: collectAllowedHosts(targets) };
}

/**
 * 実験が触ってよいホストの集合。CDK 出力に現れたものだけ。
 */
export function collectAllowedHosts(targets) {
  const hosts = new Set();
  for (const value of [targets.hardenedUrl, targets.baselineUrl, targets.cspApiEndpoint]) {
    if (typeof value === "string" && value !== "") {
      hosts.add(new URL(value).host);
    }
  }
  if (targets.cognitoDomain) {
    hosts.add(targets.cognitoDomain);
  }
  return hosts;
}

/**
 * ホワイトリストに無いホストへのアクセスを拒否する。
 * **この関数を迂回して fetch しないこと。**
 *
 * @param {string} url
 * @param {Set<string>} allowedHosts
 */
export function assertAllowedTarget(url, allowedHosts) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    throw new Error(`対象 URL が不正です: ${url}`);
  }
  if (!allowedHosts.has(host)) {
    throw new Error(
      `対象 ${host} は CDK 出力に含まれていません。実験は自分がデプロイした` +
        `リソースにしか実行できません。許可されているホスト: ${[...allowedHosts].join(", ")}`,
    );
  }
  return url;
}

/** baseline が無い構成でも実験を続けられるようにする */
export function requireBaseline(targets) {
  if (!targets.baselineUrl) {
    throw new Error(
      "baseline ディストリビューションがありません。この実験は hardened / baseline の" +
        "比較が目的なので、`-c baselineEnabled=true` でデプロイし直してください。",
    );
  }
  return targets.baselineUrl;
}
