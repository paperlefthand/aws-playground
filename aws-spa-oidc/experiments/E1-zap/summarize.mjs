/**
 * ZAP baseline scan の JSON レポートを集計する(実験 E1)。
 *
 * hardened / baseline のリスク別アラート件数を比べるのが目的。ZAP のレポート形式は
 * `site[].alerts[]` で、`riskcode` が 0(情報)〜3(高)。
 */

export const RISK_LABELS = ["Informational", "Low", "Medium", "High"];

/**
 * @param {unknown} report ZAP の -J で出る JSON
 * @returns {{ risk: string, count: number, instances: number }[]}
 */
export function summarizeZapReport(report) {
  const counts = RISK_LABELS.map((risk) => ({ risk, count: 0, instances: 0 }));

  for (const site of asArray(report?.site)) {
    for (const alert of asArray(site?.alerts)) {
      const riskCode = Number(alert?.riskcode);
      if (!Number.isInteger(riskCode) || riskCode < 0 || riskCode >= RISK_LABELS.length) {
        continue;
      }
      counts[riskCode].count += 1;
      counts[riskCode].instances += asArray(alert?.instances).length;
    }
  }

  return counts;
}

/**
 * アラートを 1 行 1 件で出す。どの警告が消えたのかを追えるようにする。
 */
export function listAlerts(report, target) {
  const rows = [];
  for (const site of asArray(report?.site)) {
    for (const alert of asArray(site?.alerts)) {
      const riskCode = Number(alert?.riskcode);
      rows.push({
        target,
        risk: RISK_LABELS[riskCode] ?? String(alert?.riskcode ?? ""),
        alert: alert?.name ?? alert?.alert ?? "",
        cwe: alert?.cweid ?? "",
        instances: asArray(alert?.instances).length,
      });
    }
  }
  return rows;
}

/**
 * hardened / baseline の差分を取り、防御で減ったアラートを見えるようにする。
 */
export function diffByRisk(hardened, baseline) {
  return RISK_LABELS.map((risk, index) => ({
    risk,
    hardened: hardened[index]?.count ?? 0,
    baseline: baseline?.[index]?.count ?? "",
    // baseline が無い構成では空欄のまま(想像で埋めない)
    reduced: baseline ? (baseline[index]?.count ?? 0) - (hardened[index]?.count ?? 0) : "",
  }));
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined || value === null ? [] : [value];
}
