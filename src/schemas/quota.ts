import { z } from "zod";

export const QuotaStateSchema = z.enum(["ok", "warn", "killed"]);

export const QuotaMetricSchema = z.object({
  value: z.number(),
  limit: z.number(),
  ratio: z.number(),
});

export const QuotaSnapshotSchema = z.object({
  state: QuotaStateSchema,
  month: z.string(),
  checkedAt: z.number().int(),
  metrics: z.object({
    storageBytes: QuotaMetricSchema,
    classAOperations: QuotaMetricSchema,
    classBOperations: QuotaMetricSchema,
  }),
  reason: z.string().optional(),
  consecutiveFetchFailures: z.number().int().nonnegative().optional(),
});

export const QuotaPublicStatusResponseSchema = z.object({
  state: QuotaStateSchema,
  checkedAt: z.number().int().nullable(),
  month: z.string(),
});

export const QuotaAdminStatusFallbackSchema = z.object({
  state: z.literal("ok"),
  checkedAt: z.null(),
  month: z.string(),
});

export const QuotaAdminStatusResponseSchema = z.union([
  QuotaSnapshotSchema,
  QuotaAdminStatusFallbackSchema,
]);

export const QuotaResetResponseSchema = z.object({
  ok: z.literal(true),
  state: z.literal("ok"),
});

export type QuotaPublicStatusResponse = z.infer<typeof QuotaPublicStatusResponseSchema>;
export type QuotaAdminStatusResponse = z.infer<typeof QuotaAdminStatusResponseSchema>;
export type QuotaResetResponse = z.infer<typeof QuotaResetResponseSchema>;
