/**
 * Worker の環境 binding 型。wrangler.toml の binding 名と一致させる。
 * spec docs/spec.md §4 / §6 / §7 を参照。
 */
export interface Env {
  /** NAR / narinfo の正本（source of truth）。read path の終点。 */
  NAR_BUCKET: R2Bucket;
  /** quota 状態と世代カウンタ、任意の nix-cache-info コピー。 */
  META_KV: KVNamespace;
  /** control plane（build履歴 / latest / rollback root / GC live set）。 */
  CONTROL_DB: D1Database;

  /** nix-cache-info の Priority 値（文字列）。 */
  CACHE_INFO_PRIORITY?: string;
  /** Cloudflare account ID (analytics API の accountTag) */
  CF_ACCOUNT_ID?: string;
  /** Cloudflare GraphQL Analytics API token (Account Analytics: Read) */
  CF_ANALYTICS_TOKEN?: string;
  /** quota 監視対象の R2 バケット名 */
  QUOTA_R2_BUCKET_NAME?: string;
  /** 管理API（publish / rollback / GC）の認証トークン（secret）。 */
  ADMIN_TOKEN?: string;
}
