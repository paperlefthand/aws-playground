/**
 * テスト用の CDK App 生成ヘルパ。
 *
 * `cdk` CLI は cdk.json の context(フィーチャーフラグを含む)を読み込んでから
 * アプリを実行するが、Vitest から直接 `new App()` するとそれが効かない。
 * フラグの有無で L2 コンストラクトの生成物が変わるため、テストが実デプロイと
 * 別物を検証してしまう。ここで cdk.json を読み込んで条件を揃える。
 *
 * スタックの組み立ては lib/lab-app.ts を通す。テスト用に別配線を書くと
 * 「テストは通るが cdk synth は落ちる」状態を作りうるため。
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { resolveContext } from "../config/context.ts";
import { CoreStack } from "../lib/core-stack.ts";
import { type LabApp, createLabApp } from "../lib/lab-app.ts";

export const TEST_ACCOUNT = "123456789012";
export const TEST_REGION = "ap-northeast-1";

const cdkJsonPath = path.join(import.meta.dirname, "..", "cdk.json");
const cdkJson = JSON.parse(readFileSync(cdkJsonPath, "utf8")) as {
  context?: Record<string, unknown>;
};

/** cdk.json の context(フィーチャーフラグ)。テストの App に必ず渡す */
export const cdkJsonContext: Record<string, unknown> = cdkJson.context ?? {};

export function createTestApp(context: Record<string, string> = {}): cdk.App {
  return new cdk.App({ context: { ...cdkJsonContext, ...context } });
}

const coreStackCache = new Map<string, CoreStack>();
const labStacksCache = new Map<string, LabApp>();

export function createCoreStack(context: Record<string, string> = {}): CoreStack {
  return memoize(coreStackCache, context, () => {
    const app = createTestApp(context);
    return new CoreStack(app, "CoreStack", {
      env: { account: TEST_ACCOUNT, region: TEST_REGION },
      labContext: resolveContext(app.node),
    });
  });
}

/**
 * 全スタックを組み立てる。テンプレートの内容だけを見るテスト用なので
 * cdk-nag は登録しない(検証プラグインは 1 回あたり数秒かかる)。
 * cdk-nag 自体の回帰は test/nag.test.ts が見る。
 */
export function createLabStacks(context: Record<string, unknown> = {}): LabApp {
  return memoize(labStacksCache, context, () =>
    createLabApp({
      account: TEST_ACCOUNT,
      withNag: false,
      context: { ...cdkJsonContext, ...context },
    }),
  );
}

/**
 * 同じ context のスタックは何度組み立てても同じなので使い回す。
 * 全スタックの構築は数秒かかり、素直に呼び直すとテストがタイムアウトする。
 * 例外(不正な context の検証)はキャッシュしない。
 */
function memoize<T>(cache: Map<string, T>, context: Record<string, unknown>, build: () => T): T {
  const key = JSON.stringify(context, Object.keys(context).sort());
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const built = build();
  cache.set(key, built);
  return built;
}
