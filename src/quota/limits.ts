export const R2_FREE_TIER = {
  storageBytes: 10 * 1_000_000_000,
  classAOperations: 1_000_000,
  classBOperations: 10_000_000,
} as const;

export const QUOTA_THRESHOLDS = {
  warn: 0.8,
  killed: 0.95,
} as const;
