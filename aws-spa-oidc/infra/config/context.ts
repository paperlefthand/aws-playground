/**
 * CDK context フラグの解決(SPEC 2.2)。
 *
 * `phase` は個別フラグのプリセットとして働き、個別フラグが明示された場合は
 * そちらを優先する。実験の再現性のため、未知の値は既定値で握りつぶさず
 * 例外にする(誤ったフラグ名でデプロイして「効いていない」ことに気付かない、
 * という事故を防ぐ)。
 */

export type Phase = "p0" | "p1" | "p2" | "p3";
export type CspMode = "off" | "report-only" | "enforce";
export type WafAction = "count" | "block";

export interface LabContext {
  readonly phase: Phase;
  readonly cspMode: CspMode;
  readonly trustedTypes: boolean;
  readonly wafAction: WafAction;
  readonly baselineEnabled: boolean;
  readonly vulnMode: boolean;
  /** 全パス対象レートベースルールの 5 分あたり閾値(SPEC 4.4 優先度 100) */
  readonly rateLimitAll: number;
  /** `/api/*` 限定レートベースルールの閾値(SPEC 4.4 優先度 110) */
  readonly rateLimitApi: number;
  /** Cognito スコープ WebACL のレートベース閾値(SPEC 4.5) */
  readonly rateLimitCognito: number;
  /** リソース名の接頭辞。Glue テーブルの location など決定的な命名に使う */
  readonly namePrefix: string;
}

/** `cdk.App` から `tryGetContext` だけを切り出したもの(テスト用) */
export interface ContextReader {
  tryGetContext(key: string): unknown;
}

type PhasePreset = Pick<LabContext, "cspMode" | "wafAction" | "trustedTypes">;

/**
 * SPEC 2.2 の `phase` プリセット(docs/PLAN.md 2 章で承認済み)。
 * 段階導入 Count → Block / Report-Only → Enforce を 1 フラグで切り替える。
 */
export const PHASE_PRESETS: Record<Phase, PhasePreset> = {
  p0: { cspMode: "off", wafAction: "count", trustedTypes: false },
  p1: { cspMode: "report-only", wafAction: "count", trustedTypes: false },
  p2: { cspMode: "enforce", wafAction: "count", trustedTypes: false },
  p3: { cspMode: "enforce", wafAction: "block", trustedTypes: false },
};

export const CONTEXT_DEFAULTS = {
  phase: "p0",
  baselineEnabled: true,
  vulnMode: false,
  rateLimitAll: 300,
  rateLimitApi: 100,
  rateLimitCognito: 100,
  namePrefix: "edge-lab",
} as const;

const PHASES: readonly Phase[] = ["p0", "p1", "p2", "p3"];
const CSP_MODES: readonly CspMode[] = ["off", "report-only", "enforce"];
const WAF_ACTIONS: readonly WafAction[] = ["count", "block"];

/** AWS WAF のレートベースルールが受け付ける下限(5 分あたり) */
const RATE_LIMIT_MIN = 10;
const RATE_LIMIT_MAX = 2_000_000_000;

export function resolveContext(reader: ContextReader): LabContext {
  const phase = parseEnum(reader, "phase", PHASES) ?? CONTEXT_DEFAULTS.phase;
  const preset = PHASE_PRESETS[phase];

  return {
    phase,
    // 個別フラグが明示されていればプリセットより優先(SPEC 2.2)
    cspMode: parseEnum(reader, "cspMode", CSP_MODES) ?? preset.cspMode,
    wafAction: parseEnum(reader, "wafAction", WAF_ACTIONS) ?? preset.wafAction,
    trustedTypes: parseBoolean(reader, "trustedTypes") ?? preset.trustedTypes,
    baselineEnabled: parseBoolean(reader, "baselineEnabled") ?? CONTEXT_DEFAULTS.baselineEnabled,
    vulnMode: parseBoolean(reader, "vulnMode") ?? CONTEXT_DEFAULTS.vulnMode,
    rateLimitAll: parseCount(reader, "rateLimitAll") ?? CONTEXT_DEFAULTS.rateLimitAll,
    rateLimitApi: parseCount(reader, "rateLimitApi") ?? CONTEXT_DEFAULTS.rateLimitApi,
    rateLimitCognito: parseCount(reader, "rateLimitCognito") ?? CONTEXT_DEFAULTS.rateLimitCognito,
    namePrefix: parseNamePrefix(reader) ?? CONTEXT_DEFAULTS.namePrefix,
  };
}

function readRaw(reader: ContextReader, key: string): string | undefined {
  const raw = reader.tryGetContext(key);
  if (raw === undefined || raw === null || raw === "") {
    return undefined;
  }
  if (typeof raw === "string") {
    return raw;
  }
  // `-c key=value` は常に文字列だが、cdk.json に直接書かれた場合は数値・真偽値になる
  if (typeof raw === "number" || typeof raw === "boolean") {
    return String(raw);
  }
  throw new Error(`context "${key}" の値の型が不正です。文字列 / 数値 / 真偽値で指定してください`);
}

function parseEnum<T extends string>(
  reader: ContextReader,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const raw = readRaw(reader, key);
  if (raw === undefined) {
    return undefined;
  }
  const match = allowed.find((candidate) => candidate === raw);
  if (match === undefined) {
    throw new Error(`context "${key}" の値 "${raw}" は不正です。許容値: ${allowed.join(" / ")}`);
  }
  return match;
}

function parseBoolean(reader: ContextReader, key: string): boolean | undefined {
  const raw = readRaw(reader, key);
  if (raw === undefined) {
    return undefined;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error(`context "${key}" の値 "${raw}" は不正です。許容値: true / false`);
}

function parseCount(reader: ContextReader, key: string): number | undefined {
  const raw = readRaw(reader, key);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < RATE_LIMIT_MIN || value > RATE_LIMIT_MAX) {
    throw new Error(
      `context "${key}" の値 "${raw}" は不正です。${RATE_LIMIT_MIN}〜${RATE_LIMIT_MAX} の整数を指定してください`,
    );
  }
  return value;
}

function parseNamePrefix(reader: ContextReader): string | undefined {
  const raw = readRaw(reader, "namePrefix");
  if (raw === undefined) {
    return undefined;
  }
  // S3 バケット名・Cognito ドメイン接頭辞にそのまま埋め込むため文字種を制限する
  if (!/^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])?$/.test(raw)) {
    throw new Error(
      `context "namePrefix" の値 "${raw}" は不正です。小文字英数字とハイフンのみ、3〜20 文字で指定してください`,
    );
  }
  return raw;
}
