/**
 * k6 の JSON サマリからレイテンシのパーセンタイルを取り出す(実験 E7)。
 */

const PERCENTILES = ["med", "p(95)", "p(99)"];
const LABELS = { med: "p50", "p(95)": "p95", "p(99)": "p99" };

/**
 * `k6 run --summary-export` が出す JSON からメトリクスを拾う。
 * @param {unknown} summary
 */
export function extractLatencies(summary) {
  const metrics = summary?.metrics ?? {};
  const rows = [];

  for (const [target, metricName] of [
    ["hardened", "hardened_latency"],
    ["baseline", "baseline_latency"],
  ]) {
    const metric = metrics[metricName];
    if (!metric) {
      continue;
    }
    const row = { target, samples: metric.count ?? metric.values?.count ?? "" };
    for (const key of PERCENTILES) {
      const value = metric[key] ?? metric.values?.[key];
      row[LABELS[key]] = typeof value === "number" ? round(value) : "";
    }
    rows.push(row);
  }

  return rows;
}

/**
 * hardened と baseline の差分。**片方しか無ければ差分を出さない**(SPEC 6)。
 * @param {{ target: string, p50?: number, p95?: number, p99?: number }[]} rows
 */
export function computeOverhead(rows) {
  const hardened = rows.find((row) => row.target === "hardened");
  const baseline = rows.find((row) => row.target === "baseline");
  if (!hardened || !baseline) {
    return [];
  }

  return ["p50", "p95", "p99"].map((percentile) => {
    const h = hardened[percentile];
    const b = baseline[percentile];
    const measurable = typeof h === "number" && typeof b === "number" && b > 0;
    return {
      percentile,
      hardened_ms: typeof h === "number" ? h : "",
      baseline_ms: typeof b === "number" ? b : "",
      overhead_ms: measurable ? round(h - b) : "",
      overhead_percent: measurable ? round(((h - b) / b) * 100) : "",
    };
  });
}

function round(value) {
  return Math.round(value * 100) / 100;
}
