/**
 * WAF ログの誤検知分析(実験 E4)。
 *
 * 誤検知率は **人間の判断なしには出せない**。「Count になったリクエストのうち、
 * 実際には正当だったものの割合」だからで、正当かどうかは自動判定できない。
 * そこでこのスクリプトは 2 段構えにする:
 *
 *   1. Athena の結果からルール別ヒット数を出し、**ラベル付け用の CSV を生成**する
 *      (`verdict` 列が空)
 *   2. 人が `verdict` を埋めた CSV を読み、誤検知率を計算する
 *
 * 想像で数値を埋めないための構造(SPEC 6)。
 */

import { text } from "../lib/text.mjs";

/** ラベル付け CSV の verdict に書ける値 */
export const VERDICTS = ["legitimate", "attack", "unknown"];

/**
 * Athena の結果行(ルール別ヒット数)を整形する。
 * @param {{ terminatingruleid?: string, action?: string, hits?: string|number }[]} rows
 */
export function toRuleHitRows(rows) {
  return (rows ?? [])
    .map((row) => ({
      rule: text(row.terminatingruleid ?? row.rule).trim(),
      action: text(row.action).trim().toUpperCase(),
      hits: Number(row.hits ?? 0),
    }))
    .filter((row) => row.rule !== "")
    .sort((a, b) => b.hits - a.hits || a.rule.localeCompare(b.rule));
}

/**
 * ラベル付け用のテンプレート。`verdict` と `note` は空で出し、人が埋める。
 * @param {{ rule: string, action: string, hits: number }[]} ruleHits
 * @param {Record<string, unknown>[]} samples Athena から取った代表リクエスト
 */
export function toLabelingRows(ruleHits, samples) {
  const rows = [];
  for (const sample of samples ?? []) {
    rows.push({
      rule: text(sample.terminatingruleid),
      action: text(sample.action).toUpperCase(),
      uri: text(sample.uri),
      client_ip: text(sample.clientip),
      country: text(sample.country),
      user_agent: text(sample.useragent),
      // 人が埋める欄。VERDICTS のいずれかを書く
      verdict: "",
      note: "",
    });
  }
  // サンプルが無いルールも行として残し、未確認であることを見えるようにする
  for (const hit of ruleHits) {
    if (!rows.some((row) => row.rule === hit.rule)) {
      rows.push({
        rule: hit.rule,
        action: hit.action,
        uri: "",
        client_ip: "",
        country: "",
        user_agent: "",
        verdict: "",
        note: "サンプル未取得",
      });
    }
  }
  return rows;
}

/**
 * 人が埋めたラベルから誤検知率を計算する。
 *
 * 分母は **判定済み(legitimate または attack)** のみ。未判定を分母に入れると
 * 「調べていない」が「攻撃だった」に化けて誤検知率を過小評価する。
 *
 * @param {{ rule: string, verdict: string }[]} labeled
 */
export function computeFalsePositiveRates(labeled) {
  const byRule = new Map();

  for (const row of labeled ?? []) {
    const rule = text(row.rule).trim();
    const verdict = text(row.verdict).trim().toLowerCase();
    if (rule === "") {
      continue;
    }
    const current = byRule.get(rule) ?? { rule, legitimate: 0, attack: 0, unlabeled: 0 };
    if (verdict === "legitimate") {
      current.legitimate += 1;
    } else if (verdict === "attack") {
      current.attack += 1;
    } else {
      current.unlabeled += 1;
    }
    byRule.set(rule, current);
  }

  return [...byRule.values()]
    .map((entry) => {
      const judged = entry.legitimate + entry.attack;
      return {
        ...entry,
        judged,
        // 判定が 1 件も無いルールは率を出さない(空欄のまま)
        false_positive_rate: judged === 0 ? "" : round(entry.legitimate / judged),
      };
    })
    .sort((a, b) => a.rule.localeCompare(b.rule));
}

/** ラベル付け CSV の妥当性検査。想定外の verdict を黙って無視しない */
export function validateLabels(labeled) {
  const problems = [];
  for (const [index, row] of (labeled ?? []).entries()) {
    const verdict = text(row.verdict).trim().toLowerCase();
    if (verdict !== "" && !VERDICTS.includes(verdict)) {
      problems.push(`${index + 2} 行目: verdict "${row.verdict}" は不正(${VERDICTS.join(" / ")})`);
    }
  }
  return problems;
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}
