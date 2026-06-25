export type QuotaState = "ok" | "warn" | "killed";

export type QuotaMetric = {
  value: number;
  limit: number;
  ratio: number;
};

export type QuotaSnapshot = {
  state: QuotaState;
  month: string;
  checkedAt: number;
  metrics: {
    storageBytes: QuotaMetric;
    classAOperations: QuotaMetric;
    classBOperations: QuotaMetric;
  };
  reason?: string;
  consecutiveFetchFailures?: number;
};
