/**
 * cdk-nag の回帰テスト。
 *
 * `app.synth()` は Policy Validation プラグイン(cdk-nag)を実際に走らせるため、
 * acknowledge されていない指摘が 1 件でもあれば例外になる。granular finding の
 * 抑制は ID 文字列の完全一致に依存していて壊れやすいので、ここで固定する。
 * (docs/OPEN_QUESTIONS.md Q8)
 *
 * 1 回の synth に数秒かかるので、実行回数は必要最小限に絞っている。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { createLabApp } from "../lib/lab-app.ts";
import { TEST_ACCOUNT, cdkJsonContext } from "./helpers.ts";

/** cdk-nag 込みの synth は重いので、通常の 5 秒では足りない */
const SYNTH_TIMEOUT_MS = 60_000;

const outdirs: string[] = [];

function synthWithNag(options: { account?: string; context?: Record<string, unknown> } = {}) {
  const outdir = mkdtempSync(path.join(tmpdir(), "edge-lab-nag-"));
  outdirs.push(outdir);
  const { app, coreStack, wafEdgeStack, wafCognitoStack, deliveryStack } = createLabApp({
    account: options.account,
    outdir,
    context: { ...cdkJsonContext, ...options.context },
  });
  return {
    assembly: app.synth(),
    stackNames: [
      coreStack.stackName,
      wafEdgeStack.stackName,
      wafCognitoStack.stackName,
      deliveryStack.stackName,
    ],
  };
}

afterAll(() => {
  for (const dir of outdirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("cdk-nag (AwsSolutions)", () => {
  it(
    "未 acknowledge の指摘が無く、抑制の理由がテンプレートに残る",
    () => {
      const { assembly, stackNames } = synthWithNag({ account: TEST_ACCOUNT });

      const suppressed = stackNames.flatMap((stackName) => {
        const template = assembly.getStackByName(stackName).template as {
          Resources: Record<string, { Metadata?: { cdk_nag?: { rules_to_suppress: unknown[] } } }>;
        };
        return Object.values(template.Resources).flatMap(
          (resource) => resource.Metadata?.cdk_nag?.rules_to_suppress ?? [],
        );
      });
      expect(suppressed.length).toBeGreaterThan(0);

      // 理由の無い抑制を作らない(SPEC 4.8)
      const withoutReason = suppressed.filter(
        (rule) => typeof (rule as { reason?: string }).reason !== "string",
      );
      expect(withoutReason).toEqual([]);
    },
    SYNTH_TIMEOUT_MS,
  );

  // finding ID には対象リソースの ARN がそのまま入る。ARN を具体値のアカウントで
  // 組み立てると認証情報の有無で ID が変わり、抑制が環境依存で外れる。
  it(
    "認証情報が無くても抑制が外れない",
    () => {
      expect(() => synthWithNag({ account: undefined })).not.toThrow();
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "context を変えても抑制が外れない",
    () => {
      expect(() =>
        synthWithNag({
          account: TEST_ACCOUNT,
          context: { namePrefix: "my-lab", phase: "p3" },
        }),
      ).not.toThrow();
    },
    SYNTH_TIMEOUT_MS,
  );

  // baseline を作らない場合、baseline 向けの抑制も作られない。
  // 不要な抑制が残っていないかの確認も兼ねる。
  it(
    "baselineEnabled=false でも抑制が過不足なく揃う",
    () => {
      expect(() =>
        synthWithNag({ account: TEST_ACCOUNT, context: { baselineEnabled: "false" } }),
      ).not.toThrow();
    },
    SYNTH_TIMEOUT_MS,
  );
});
