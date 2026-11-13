import { describe, expect, it } from "vite-plus/test";
import { diffByRisk, listAlerts, summarizeZapReport } from "../E1-zap/summarize.mjs";
import { detectCspMode, scoreHeaders, toComparisonRows } from "../E2-headers/rubric.mjs";
import {
  aggregateViolations,
  normalizeBlockedUri,
  parseInsightsRows,
  summarize,
} from "../E3-csp/aggregate.mjs";
import {
  computeFalsePositiveRates,
  toRuleHitRows,
  validateLabels,
} from "../E4-waf-tuning/analyze.mjs";
import { computeOverhead, extractLatencies } from "../E7-overhead/summarize.mjs";
import { EXFIL_HOST, compareTargets, evaluateObservation } from "../E8-xss/payloads.mjs";
import { toCsv } from "../lib/csv.mjs";
import { parseCsv } from "../lib/parse-csv.mjs";
import { summarizeProbe } from "../lib/rate-probe.mjs";
import { timestampDir } from "../lib/results.mjs";

describe("E1: ZAP レポートの集計", () => {
  const report = {
    site: [
      {
        alerts: [
          { name: "Missing CSP", riskcode: "2", instances: [{}, {}] },
          { name: "Info leak", riskcode: "0", instances: [{}] },
          { name: "XSS", riskcode: "3", instances: [{}] },
        ],
      },
    ],
  };

  it("リスク別に件数とインスタンス数を数える", () => {
    const summary = summarizeZapReport(report);
    expect(summary.find((row) => row.risk === "Medium")).toEqual({
      risk: "Medium",
      count: 1,
      instances: 2,
    });
    expect(summary.find((row) => row.risk === "High")?.count).toBe(1);
  });

  it("hardened で減ったアラート数を出す", () => {
    const hardened = summarizeZapReport({ site: [{ alerts: [{ riskcode: "2", instances: [] }] }] });
    const baseline = summarizeZapReport({
      site: [{ alerts: [{ riskcode: "2" }, { riskcode: "2" }, { riskcode: "2" }] }],
    });
    expect(diffByRisk(hardened, baseline).find((row) => row.risk === "Medium")?.reduced).toBe(2);
  });

  // baseline を作っていない構成では差分を書かない(SPEC 6)
  it("baseline が無ければ差分欄は空", () => {
    const hardened = summarizeZapReport(report);
    expect(diffByRisk(hardened, undefined).every((row) => row.reduced === "")).toBe(true);
  });

  it("空のレポートでも落ちない", () => {
    expect(summarizeZapReport({}).every((row) => row.count === 0)).toBe(true);
    expect(listAlerts({}, "hardened")).toEqual([]);
  });
});

describe("E2: ヘッダ採点", () => {
  const hardenedHeaders = {
    "strict-transport-security": "max-age=63072000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), browsing-topics=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "content-security-policy": "default-src 'none'; script-src 'self'",
    "reporting-endpoints": 'csp-endpoint="/api/csp-report"',
  };

  it("hardened のヘッダで満点になる", () => {
    const score = scoreHeaders(hardenedHeaders);
    expect(score.passed).toBe(score.total);
    expect(score.cspMode).toBe("enforce");
  });

  it("baseline(ヘッダ無し)は 0 点", () => {
    const score = scoreHeaders({});
    expect(score.passed).toBe(0);
    expect(score.cspMode).toBe("off");
  });

  it("ヘッダ名の大文字小文字を無視する", () => {
    expect(
      scoreHeaders({ "X-Frame-Options": "DENY" }).checks.find((c) => c.id === "frame-options")
        ?.pass,
    ).toBe(true);
  });

  // 'unsafe-inline' を足して通そうとしても加点されないこと
  it("unsafe-inline を含む CSP は減点される", () => {
    const score = scoreHeaders({
      ...hardenedHeaders,
      "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'",
    });
    expect(score.checks.find((check) => check.id === "csp-no-unsafe")?.pass).toBe(false);
  });

  it("report-only を enforce と取り違えない", () => {
    expect(detectCspMode({ "content-security-policy-report-only": "default-src 'none'" })).toBe(
      "report-only",
    );
  });

  it("baseline が無ければ比較欄は空", () => {
    const rows = toComparisonRows(scoreHeaders(hardenedHeaders), undefined);
    expect(rows.every((row) => row.baseline_pass === "")).toBe(true);
  });
});

describe("E3: CSP 違反の集計", () => {
  const records = [
    { effectiveDirective: "script-src", blockedUri: "https://evil.example.com/a.js" },
    { effectiveDirective: "script-src", blockedUri: "https://evil.example.com/b.js" },
    { effectiveDirective: "img-src", blockedUri: "inline" },
  ];

  it("ディレクティブ × blocked-uri の頻度表を作る", () => {
    const rows = aggregateViolations(records);
    expect(rows[0]).toMatchObject({
      effective_directive: "script-src",
      blocked_uri: "https://evil.example.com",
      count: 2,
    });
  });

  // 具体的な URL のままだと頻度表にならない
  it("blocked-uri をオリジン単位に丸める", () => {
    expect(normalizeBlockedUri("https://evil.example.com/x/y?z=1")).toBe(
      "https://evil.example.com",
    );
    expect(normalizeBlockedUri("inline")).toBe("inline");
    expect(normalizeBlockedUri(undefined)).toBe("");
  });

  it("コレクタ以外のログ行を無視する", () => {
    const rows = parseInsightsRows([
      [
        {
          field: "@message",
          value: JSON.stringify({ kind: "csp-violation", effectiveDirective: "script-src" }),
        },
      ],
      [{ field: "@message", value: "START RequestId: xxx" }],
      [{ field: "@message", value: JSON.stringify({ kind: "csp-collector.rejected" }) }],
    ]);
    expect(rows).toHaveLength(1);
  });

  // 0 件を「違反なし」と即断させない(docs/OPEN_QUESTIONS.md Q6)
  it("0 件のときは注意書きを付ける", () => {
    expect(summarize([]).zeroViolationCaveat).toContain("0 件");
    expect(summarize(records).zeroViolationCaveat).toBeNull();
  });
});

describe("E4: WAF 誤検知分析", () => {
  it("ルール別ヒット数を件数の多い順に並べる", () => {
    const rows = toRuleHitRows([
      { terminatingruleid: "A", action: "count", hits: "3" },
      { terminatingruleid: "B", action: "BLOCK", hits: "10" },
      { terminatingruleid: "", action: "COUNT", hits: "5" },
    ]);
    expect(rows.map((row) => row.rule)).toEqual(["B", "A"]);
    expect(rows[1].action).toBe("COUNT");
  });

  // 未判定を分母に入れると誤検知率を過小評価する
  it("誤検知率の分母は判定済みのみ", () => {
    const rates = computeFalsePositiveRates([
      { rule: "R1", verdict: "legitimate" },
      { rule: "R1", verdict: "legitimate" },
      { rule: "R1", verdict: "attack" },
      { rule: "R1", verdict: "" },
    ]);
    expect(rates[0]).toMatchObject({ judged: 3, unlabeled: 1, false_positive_rate: 0.6667 });
  });

  it("1 件も判定されていないルールは率を出さない", () => {
    const rates = computeFalsePositiveRates([{ rule: "R2", verdict: "" }]);
    expect(rates[0].false_positive_rate).toBe("");
  });

  it("想定外の verdict を報告する", () => {
    const problems = validateLabels([{ rule: "R1", verdict: "maybe" }]);
    expect(problems[0]).toContain("maybe");
    expect(validateLabels([{ rule: "R1", verdict: "attack" }])).toEqual([]);
  });
});

describe("E7: オーバーヘッド集計", () => {
  const summary = {
    metrics: {
      hardened_latency: { count: 100, med: 42.123, "p(95)": 80.5, "p(99)": 120.9 },
      baseline_latency: { count: 100, med: 40, "p(95)": 75, "p(99)": 110 },
    },
  };

  it("k6 サマリからパーセンタイルを取り出す", () => {
    const rows = extractLatencies(summary);
    expect(rows.find((row) => row.target === "hardened")).toMatchObject({ p50: 42.12, p95: 80.5 });
  });

  it("hardened と baseline の差分を出す", () => {
    const overhead = computeOverhead(extractLatencies(summary));
    expect(overhead.find((row) => row.percentile === "p50")).toMatchObject({
      overhead_ms: 2.12,
      // p50 は 42.12 に丸めてから比較するので (42.12 - 40) / 40 = 5.3%
      overhead_percent: 5.3,
    });
  });

  // 片方しか測れていないのに差分を作らない(SPEC 6)
  it("baseline が無ければ差分を出さない", () => {
    const rows = extractLatencies({ metrics: { hardened_latency: { med: 10 } } });
    expect(computeOverhead(rows)).toEqual([]);
  });
});

describe("E8: XSS の影響範囲", () => {
  it("外部ホストへのリクエストを送信成立と判定する", () => {
    const row = evaluateObservation({
      payloadId: "img-src",
      target: "baseline",
      requests: [`https://${EXFIL_HOST}/steal?c=1`],
      consoleErrors: [],
    });
    expect(row.exfiltration_succeeded).toBe(1);
  });

  it("CSP 違反のコンソールエラーを数える", () => {
    const row = evaluateObservation({
      payloadId: "img-src",
      target: "hardened",
      requests: [],
      consoleErrors: ["Refused to load the image because it violates the Content Security Policy"],
    });
    expect(row.exfiltration_succeeded).toBe(0);
    expect(row.csp_violation_logged).toBe(1);
  });

  it("baseline で成立し hardened で止まったものを CSP の効果として数える", () => {
    const comparison = compareTargets([
      {
        payload: "img-src",
        target: "baseline",
        exfiltration_succeeded: 1,
        csp_violation_logged: 0,
      },
      {
        payload: "img-src",
        target: "hardened",
        exfiltration_succeeded: 0,
        csp_violation_logged: 1,
      },
    ]);
    expect(comparison[0].blocked_by_csp).toBe(1);
  });

  it("片方しか観測できていなければ判定しない", () => {
    const comparison = compareTargets([
      {
        payload: "img-src",
        target: "hardened",
        exfiltration_succeeded: 0,
        csp_violation_logged: 1,
      },
    ]);
    expect(comparison[0].blocked_by_csp).toBe("");
  });
});

describe("E5 / E6: レート測定の要約", () => {
  it("何回目でブロックされたかを出す", () => {
    const summary = summarizeProbe([
      { attempt: 1, elapsedMs: 0, wafBlocked: false, unmarkedForbidden: false },
      { attempt: 2, elapsedMs: 100, wafBlocked: true, unmarkedForbidden: false },
    ]);
    expect(summary).toMatchObject({ attemptsUntilBlocked: 2, timeToBlockMs: 100, blocked: true });
  });

  // 未観測を 0 や最大値で埋めない(SPEC 6)
  it("ブロックが観測できなければ null と注意書きにする", () => {
    const summary = summarizeProbe([
      { attempt: 1, elapsedMs: 0, wafBlocked: false, unmarkedForbidden: false },
    ]);
    expect(summary.attemptsUntilBlocked).toBeNull();
    expect(summary.note).toContain("観測できません");
  });

  it("印の無い 403 を別に数える", () => {
    const summary = summarizeProbe([
      { attempt: 1, elapsedMs: 0, wafBlocked: false, unmarkedForbidden: true },
    ]);
    expect(summary.unmarkedForbiddenCount).toBe(1);
  });
});

describe("結果出力の共通処理", () => {
  it("タイムスタンプが辞書順 = 時系列順になる", () => {
    const earlier = timestampDir(new Date("2026-08-14T01:02:03.000Z"));
    const later = timestampDir(new Date("2026-08-14T01:02:04.000Z"));
    expect(earlier).toBe("2026-08-14T01-02-03Z");
    expect(earlier < later).toBe(true);
  });

  it("CSV のカンマ・引用符・改行をエスケープする", () => {
    const csv = toCsv([{ a: 'x,"y"', b: "line1\nline2" }]);
    expect(csv).toBe('a,b\n"x,""y""","line1\nline2"\n');
  });

  // 表計算ソフトが式として解釈するのを防ぐ
  it("先頭が = の値を式として解釈させない", () => {
    expect(toCsv([{ a: "=1+1" }])).toContain("'=1+1");
  });

  it("人が編集した CSV を読み戻せる", () => {
    const rows = parseCsv('rule,verdict,note\nR1,legitimate,"社内 IP, VPN 経由"\nR2,attack,\n');
    expect(rows).toEqual([
      { rule: "R1", verdict: "legitimate", note: "社内 IP, VPN 経由" },
      { rule: "R2", verdict: "attack", note: "" },
    ]);
  });
});
