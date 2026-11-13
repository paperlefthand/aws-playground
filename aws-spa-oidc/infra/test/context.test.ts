import { describe, expect, it } from "vite-plus/test";
import {
  CONTEXT_DEFAULTS,
  PHASE_PRESETS,
  type ContextReader,
  resolveContext,
} from "../config/context.ts";

function reader(values: Record<string, unknown>): ContextReader {
  return { tryGetContext: (key) => values[key] };
}

describe("resolveContext", () => {
  it("context 未指定なら p0 のプリセットになる", () => {
    const resolved = resolveContext(reader({}));
    expect(resolved.phase).toBe("p0");
    expect(resolved.cspMode).toBe("off");
    expect(resolved.wafAction).toBe("count");
    expect(resolved.trustedTypes).toBe(false);
    expect(resolved.baselineEnabled).toBe(true);
    expect(resolved.vulnMode).toBe(false);
    expect(resolved.namePrefix).toBe(CONTEXT_DEFAULTS.namePrefix);
  });

  it.each(["p0", "p1", "p2", "p3"] as const)("phase=%s がプリセットを適用する", (phase) => {
    const resolved = resolveContext(reader({ phase }));
    expect(resolved.cspMode).toBe(PHASE_PRESETS[phase].cspMode);
    expect(resolved.wafAction).toBe(PHASE_PRESETS[phase].wafAction);
  });

  it("段階導入の順序どおりに強度が上がる", () => {
    expect(PHASE_PRESETS.p0.cspMode).toBe("off");
    expect(PHASE_PRESETS.p1.cspMode).toBe("report-only");
    expect(PHASE_PRESETS.p2.cspMode).toBe("enforce");
    expect(PHASE_PRESETS.p3.wafAction).toBe("block");
    // p3 以外は WAF を Block にしない(コスト事故と誤検知の巻き添えを防ぐ)
    expect(PHASE_PRESETS.p2.wafAction).toBe("count");
  });

  it("個別フラグはプリセットより優先される(SPEC 2.2)", () => {
    const resolved = resolveContext(reader({ phase: "p3", cspMode: "report-only" }));
    expect(resolved.cspMode).toBe("report-only");
    // 明示していない wafAction はプリセットのまま
    expect(resolved.wafAction).toBe("block");
  });

  it("真偽値フラグは文字列で受け取れる", () => {
    const resolved = resolveContext(
      reader({ trustedTypes: "true", baselineEnabled: "false", vulnMode: "true" }),
    );
    expect(resolved.trustedTypes).toBe(true);
    expect(resolved.baselineEnabled).toBe(false);
    expect(resolved.vulnMode).toBe(true);
  });

  it("レート閾値を上書きできる", () => {
    const resolved = resolveContext(
      reader({ rateLimitAll: "500", rateLimitApi: "50", rateLimitCognito: "20" }),
    );
    expect(resolved.rateLimitAll).toBe(500);
    expect(resolved.rateLimitApi).toBe(50);
    expect(resolved.rateLimitCognito).toBe(20);
  });

  // 誤ったフラグ値を既定値で握りつぶすと「効いていない」ことに気付けない
  it.each([
    ["phase", "p9"],
    ["cspMode", "enforced"],
    ["wafAction", "blocked"],
    ["trustedTypes", "yes"],
    ["baselineEnabled", "1"],
  ])("不正な %s は例外にする", (key, value) => {
    expect(() => resolveContext(reader({ [key]: value }))).toThrow(/不正/);
  });

  it("レート閾値が下限未満なら例外にする", () => {
    expect(() => resolveContext(reader({ rateLimitAll: "5" }))).toThrow(/不正/);
    expect(() => resolveContext(reader({ rateLimitApi: "1.5" }))).toThrow(/不正/);
  });

  it("namePrefix は S3 / Cognito に埋め込める文字種だけ許す", () => {
    expect(resolveContext(reader({ namePrefix: "my-lab" })).namePrefix).toBe("my-lab");
    expect(() => resolveContext(reader({ namePrefix: "My_Lab" }))).toThrow(/不正/);
    expect(() => resolveContext(reader({ namePrefix: "ab" }))).toThrow(/不正/);
  });
});
