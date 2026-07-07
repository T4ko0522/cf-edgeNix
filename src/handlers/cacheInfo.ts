import type { Env } from "../types";
import * as kv from "../storage/kv";
import * as r2 from "../storage/r2";
import { CACHE_INFO_KV_KEY, CACHE_INFO_R2_KEY } from "../storage/keys";

/**
 * GET /nix-cache-info
 *
 * read path: Workers Cache(edge) → KV → R2（D1 は挟まない・spec §6.1 / §10）。
 * R2 にも無ければ、binding の Priority から既定値を生成して返す。
 * edge 層は Workers Cache が担い、L0 メモリキャッシュは廃止（narinfo と同じ理由）。
 * 内容が可変（Priority 変更など）のため、再 publish 時は `cache-info` タグで purge できる。
 */
export async function handleCacheInfo(env: Env): Promise<Response> {
  const body = await resolveCacheInfo(env);
  return new Response(body, {
    headers: {
      "content-type": "text/x-nix-cache-info",
      "cache-control": "public, max-age=3600",
      "cache-tag": "cache-info",
    },
  });
}

async function resolveCacheInfo(env: Env): Promise<string> {
  const kvHit = await kv.getText(env, CACHE_INFO_KV_KEY);
  if (kvHit !== null) return kvHit;

  const r2Hit = await r2.getText(env, CACHE_INFO_R2_KEY);
  if (r2Hit !== null) return r2Hit;

  // 終端フォールバック: publish で nix-cache-info を上げていない場合でも cache として機能させる。
  const priority = env.CACHE_INFO_PRIORITY ?? "30";
  return `StoreDir: /nix/store\nWantMassQuery: 1\nPriority: ${priority}\n`;
}
