import { R2_FREE_TIER, QUOTA_THRESHOLDS } from "./limits";
import type { QuotaMetric, QuotaSnapshot, QuotaState } from "./types";

type RawUsage = {
  storageBytes: number;
  classAOperations: number;
  classBOperations: number;
};

type MetricName = keyof RawUsage;

export function evaluate(
  raw: RawUsage,
  opts: { month: string; checkedAt: number },
): QuotaSnapshot {
  const metrics: QuotaSnapshot["metrics"] = {
    storageBytes: metric(raw.storageBytes, R2_FREE_TIER.storageBytes),
    classAOperations: metric(raw.classAOperations, R2_FREE_TIER.classAOperations),
    classBOperations: metric(raw.classBOperations, R2_FREE_TIER.classBOperations),
  };

  const killedMetric = findThresholdMetric(metrics, QUOTA_THRESHOLDS.killed);
  if (killedMetric) {
    const m = metrics[killedMetric];
    return {
      state: "killed",
      month: opts.month,
      checkedAt: opts.checkedAt,
      metrics,
      reason: `${killedMetric} exceeded 95% (${m.value}/${m.limit})`,
    };
  }

  const state: QuotaState = findThresholdMetric(metrics, QUOTA_THRESHOLDS.warn) ? "warn" : "ok";
  return {
    state,
    month: opts.month,
    checkedAt: opts.checkedAt,
    metrics,
  };
}

function metric(value: number, limit: number): QuotaMetric {
  return {
    value,
    limit,
    ratio: value / limit,
  };
}

function findThresholdMetric(
  metrics: QuotaSnapshot["metrics"],
  threshold: number,
): MetricName | null {
  for (const name of ["storageBytes", "classAOperations", "classBOperations"] as const) {
    if (metrics[name].ratio >= threshold) return name;
  }
  return null;
}
