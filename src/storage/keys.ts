/**
 * R2 / KV のキー命名を一箇所に集約する。
 * store hash から lookup なしに直接引ける「決定的キー」を作るのが要点（spec §6.1）。
 */

/** R2 上の narinfo オブジェクトキー。例: `<store-hash>.narinfo` */
export function narinfoR2Key(storeHash: string): string {
  return `${storeHash}.narinfo`;
}

/** R2 上の NAR オブジェクトキー。例: `nar/<file-hash>.nar.zst` */
export function narR2Key(fileName: string): string {
  return `nar/${fileName}`;
}

/** R2 上の nix-cache-info オブジェクトキー。 */
export const CACHE_INFO_R2_KEY = "nix-cache-info";

/** KV 上の narinfo キー。 */
export function narinfoKVKey(storeHash: string): string {
  return `narinfo:${storeHash}`;
}

/** KV 上の nix-cache-info キー。 */
export const CACHE_INFO_KV_KEY = "nix-cache-info";
