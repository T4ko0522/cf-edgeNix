import { z } from "zod";
import { BuildIdSchema, HostSchema } from "./params";

// ─── POST /api/hosts/:host/rollback ──────────────────────────────────────────

export const RollbackRequestSchema = z.object({
  build_id: BuildIdSchema,
  reason: z.string().optional(),
  pinned: z.boolean().optional(),
  keep_until: z.number().int().positive().optional(),
});

export const RollbackResponseSchema = z.object({
  ok: z.literal(true),
  rollback_root_id: z.string(),
});

export type RollbackRequest = z.infer<typeof RollbackRequestSchema>;
export type RollbackResponse = z.infer<typeof RollbackResponseSchema>;

// ─── POST /api/gc/dry-run ────────────────────────────────────────────────────

export const GcDryRunResponseSchema = z.object({
  live_nar_keys: z.array(z.string()),
  dead_candidates: z.array(z.string()),
});

export type GcDryRunResponse = z.infer<typeof GcDryRunResponseSchema>;

// ─── GET /api/hosts/:host/latest ─────────────────────────────────────────────

export const LatestBuildResponseSchema = z.object({
  id: z.string(),
  host: HostSchema,
  system: z.string(),
  gitRev: z.string(),
  flakeLockHash: z.string(),
  toplevelStorePath: z.string(),
  status: z.enum(["staging", "published", "failed"]),
  retentionClass: z.string().nullable(),
  createdAt: z.number().int(),
  publishedAt: z.number().int().nullable(),
});

export type LatestBuildResponse = z.infer<typeof LatestBuildResponseSchema>;

// ─── GET /api/hosts/:host/builds ─────────────────────────────────────────────

export const BuildsListResponseSchema = z.object({
  host: HostSchema,
  builds: z.array(LatestBuildResponseSchema),
});

export type BuildsListResponse = z.infer<typeof BuildsListResponseSchema>;

// ─── GET /api/builds/:build_id/manifest.json ─────────────────────────────────

export const ManifestJsonResponseSchema = z.object({
  buildId: z.string(),
  host: HostSchema,
  system: z.string(),
  gitRev: z.string(),
  flakeLockHash: z.string(),
  toplevelStorePath: z.string(),
  closureJsonKey: z.string(),
  manifestKey: z.string(),
  manifestHash: z.string(),
  createdAt: z.number().int(),
});

export type ManifestJsonResponse = z.infer<typeof ManifestJsonResponseSchema>;

// ─── エラーレスポンス ─────────────────────────────────────────────────────────

export const ApiErrorSchema = z.object({
  error: z.string(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
