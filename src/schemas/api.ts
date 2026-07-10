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

// ─── PATCH /api/builds/:build_id ─────────────────────────────────────────────

export const PatchBuildRequestSchema = z.object({
  pinned: z.boolean(),
  reason: z.string().optional(),
});

export const PatchBuildResponseSchema = z.object({
  ok: z.literal(true),
  build_id: z.string(),
  pinned: z.boolean(),
});

export type PatchBuildRequest = z.infer<typeof PatchBuildRequestSchema>;
export type PatchBuildResponse = z.infer<typeof PatchBuildResponseSchema>;

// ─── POST /api/gc/dry-run ────────────────────────────────────────────────────

export const GcDryRunResponseSchema = z.object({
  live_nar_keys: z.array(z.string()),
  dead_candidates: z.array(z.string()),
});

export type GcDryRunResponse = z.infer<typeof GcDryRunResponseSchema>;

// ─── POST /api/gc/execute ───────────────────────────────────────────────────

export const GcExecuteRequestSchema = z.object({
  // phase デフォルトは narinfo (= grace period を挟む前提で narinfo を先に unpublish する)。
  // NAR の物理削除は grace 経過後に明示的に `phase: "nar"` で呼び直すこと。
  // `phase: "all"` は grace を無視した即時削除であり edge / Nix client が古い narinfo を
  // 持つ間 404 を撒くリスクがあるため、開発・テスト用途以外では使わない。
  phase: z.enum(["narinfo", "nar", "all"]).default("narinfo"),
  // Free プラン subrequest 上限 50/invocation に収めるため KV narinfo delete (=1 subreq/件) の本数を絞る。
  // computeLiveSet + listDeadStorePaths + R2 bulk delete×2 + D1 COUNT×3 + D1 batch×3 で固定 ~14 subreq 消費するため KV に使える残予算は ~36 件。
  // デフォルトは余裕を見て 40、上限も 50 にハードキャップ。
  max_deletes: z.number().int().positive().max(50).default(40),
  dry_run: z.boolean().default(false),
});

// `*_attempted` は KV/R2 の delete を呼んだ件数 (no-op を含む)。`d1_*` は事前 COUNT で確定した実削除件数。
export const GcExecuteDeletedSchema = z.object({
  kv_narinfo_attempted: z.number().int().nonnegative(),
  r2_narinfo_attempted: z.number().int().nonnegative(),
  r2_nar_attempted: z.number().int().nonnegative(),
  d1_store_paths: z.number().int().nonnegative(),
  d1_nar_files: z.number().int().nonnegative(),
  d1_build_closure: z.number().int().nonnegative(),
});

export const GcExecuteResponseSchema = z.object({
  ok: z.literal(true),
  phase: z.enum(["narinfo", "nar", "all"]),
  dry_run: z.boolean(),
  dead_total: z.number().int().nonnegative(),
  processed: z.number().int().nonnegative(),
  dead_remaining: z.number().int().nonnegative(),
  deleted: GcExecuteDeletedSchema,
  // Workers Cache のタグ purge が成功したタグ数（best-effort・非対応ランタイムでは 0）。
  edge_purge_attempted: z.number().int().nonnegative(),
});

export type GcExecuteRequest = z.infer<typeof GcExecuteRequestSchema>;
export type GcExecuteResponse = z.infer<typeof GcExecuteResponseSchema>;

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
