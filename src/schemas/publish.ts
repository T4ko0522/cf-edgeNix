import { z } from "zod";
import { BuildIdSchema, HostSchema, StoreHashSchema } from "./params";

// ─── フィールド制約 ───────────────────────────────────────────────────────────

/**
 * sha256 ハッシュ専用スキーマ。受理形式と長さは sha256 (32 bytes) の各 encoding に固定。
 *
 *   - `sha256:<hex>`         hex (base16) — 64 文字
 *   - `sha256:<nix-base32>`  Nix-base32 — 52 文字。alphabet `0123456789abcdfghijklmnpqrsvwxyz` (e/o/t/u を除外)
 *   - `sha256-<base64>=`     SRI / 標準 base64 — 43 文字 + `=` パディング 1 つ
 *
 * Nix が narinfo (`NarHash:` / `FileHash:`) に書く既定表現は Nix-base32。
 * sha512 等の他アルゴリズムは対象外 (必要になったら別 schema を切る)。
 */
const Sha256NixHashSchema = z
  .string()
  .regex(
    /^sha256:([0-9a-f]{64}|[0-9a-df-np-sv-z]{52})$|^sha256-[A-Za-z0-9+/]{43}=$/,
    "Invalid sha256 hash format (must be sha256:<hex(64)|nix-base32(52)> or sha256-<base64(43)>=)",
  );

/** R2/KV key: 安全な文字集合のみ、`.` 連続・`..` 不可、先頭末尾スラッシュ不可 */
const SafeKeySchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9._/-]+$/, "Key contains unsafe characters")
  .refine((s) => !s.includes(".."), "Key must not contain '..'")
  .refine((s) => !s.startsWith("/") && !s.endsWith("/"), "Key must not start or end with '/'");

/** NAR ファイルキー: nar/<hash>.nar[.xz|.zst|.gz|.br] */
const NarKeySchema = z
  .string()
  .regex(
    /^nar\/[0-9a-z]+\.nar(\.(xz|zst|gz|br))?$/,
    "Invalid NAR key format (must be nar/<hash>.nar[.xz|.zst|.gz|.br])",
  );

/** narinfo キー: <storeHash>.narinfo */
const NarinfoKeySchema = z
  .string()
  .regex(
    /^[0-9a-z]+\.narinfo$/,
    "Invalid narinfo key format (must be <storeHash>.narinfo)",
  );

/** store path: /nix/store/<hash>-<name> */
const StorePathSchema = z
  .string()
  .regex(
    /^\/nix\/store\/[0-9a-z]+-[a-zA-Z0-9._+?=-]+$/,
    "Invalid store path format (must be /nix/store/<hash>-<name>)",
  );

/** compression: 既知の圧縮形式のみ許可 */
const CompressionSchema = z.enum(["zstd", "xz", "none", "gzip", "br", "bzip2"]);

// ─── スキーマ定義 ─────────────────────────────────────────────────────────────

/** .narinfo 1 エントリのメタ情報 (API contract) */
export const NarinfoMetaSchema = z.object({
  storeHash: StoreHashSchema,
  storePath: StorePathSchema,
  narinfoKey: NarinfoKeySchema,
  narKey: NarKeySchema,
  narHash: Sha256NixHashSchema,
  narSize: z.number().int().positive(),
  fileHash: Sha256NixHashSchema,
  fileSize: z.number().int().positive(),
  compression: CompressionSchema,
  firstSeenBuildId: z.string().optional(),
});

export type NarinfoMetaInput = z.input<typeof NarinfoMetaSchema>;
export type NarinfoMeta = z.infer<typeof NarinfoMetaSchema>;

/** build 基本情報 (API contract) */
export const BuildMetaSchema = z.object({
  id: BuildIdSchema,
  host: HostSchema,
  system: z.string().min(1).max(64),
  gitRev: z.string().min(1).max(512),
  flakeLockHash: z.string().min(1).max(512),
  toplevelStorePath: StorePathSchema,
  createdAt: z.number().int().positive(),
});

export type BuildMetaInput = z.input<typeof BuildMetaSchema>;
export type BuildMetaOutput = z.infer<typeof BuildMetaSchema>;

/** manifest 情報 (API contract) */
export const ManifestMetaSchema = z.object({
  host: HostSchema,
  system: z.string().min(1).max(64),
  gitRev: z.string().min(1).max(512),
  flakeLockHash: z.string().min(1).max(512),
  toplevelStorePath: StorePathSchema,
  closureJsonKey: SafeKeySchema,
  manifestKey: SafeKeySchema,
  manifestHash: Sha256NixHashSchema,
});

export type ManifestMetaInput = z.input<typeof ManifestMetaSchema>;
export type ManifestMeta = z.infer<typeof ManifestMetaSchema>;

// ─── POST /api/publish/start ─────────────────────────────────────────────────

export const PublishStartRequestSchema = z.object({
  build: BuildMetaSchema,
});

export const PublishStartResponseSchema = z.object({
  ok: z.literal(true),
  build_id: z.string(),
});

export type PublishStartRequest = z.infer<typeof PublishStartRequestSchema>;
export type PublishStartResponse = z.infer<typeof PublishStartResponseSchema>;

// ─── POST /api/publish/:build_id/ingest ─────────────────────────────────────

export const PublishIngestRequestSchema = z.object({
  storePaths: z.array(NarinfoMetaSchema),
});

export const PublishIngestResponseSchema = z.object({
  ok: z.literal(true),
  ingested: z.number().int().nonnegative(),
});

export type PublishIngestRequest = z.infer<typeof PublishIngestRequestSchema>;
export type PublishIngestResponse = z.infer<typeof PublishIngestResponseSchema>;

// ─── POST /api/publish/:build_id/finalize ────────────────────────────────────

export const PublishFinalizeRequestSchema = z.object({
  manifest: ManifestMetaSchema,
});

export const PublishFinalizeResponseSchema = z.object({
  ok: z.literal(true),
  published_at: z.number().int().positive(),
});

export type PublishFinalizeRequest = z.infer<typeof PublishFinalizeRequestSchema>;
export type PublishFinalizeResponse = z.infer<typeof PublishFinalizeResponseSchema>;
