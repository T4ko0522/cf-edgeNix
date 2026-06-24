/**
 * Worker の環境 binding 型。wrangler.toml の binding 名と一致させる。
 * spec docs/spec.md §4 / §6 / §7 を参照。
 */
export interface Env {
  /** NAR / narinfo の正本（source of truth）。read path の終点。 */
  NAR_BUCKET: R2Bucket;
  /** narinfo / nix-cache-info の速度層（結果整合・正本ではない）。 */
  META_KV: KVNamespace;
  /** control plane（build履歴 / latest / rollback root / GC live set）。 */
  CONTROL_DB: D1Database;

  /** nix-cache-info の Priority 値（文字列）。 */
  CACHE_INFO_PRIORITY?: string;
  /** 管理API（publish / rollback / GC）の認証トークン（secret）。 */
  ADMIN_TOKEN?: string;
}
