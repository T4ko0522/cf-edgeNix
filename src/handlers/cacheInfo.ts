import type { Env } from "../types";
import * as memory from "../cache/memory";
import * as kv from "../storage/kv";
import * as r2 from "../storage/r2";
import { CACHE_INFO_KV_KEY, CACHE_INFO_R2_KEY } from "../storage/keys";

/**
 * GET /nix-cache-info
 *
 * read path: memory → KV → R2（D1 は挟まない・spec §6.1 / §10）。
 * R2 にも無ければ、binding の Priority から既定値を生成して返す。
 */
export async function handleCacheInfo(env: Env): Promise<Response> {
  const body = await resolveCacheInfo(env);
  return new Response(body, {
    headers: {
      "content-type": "text/x-nix-cache-info",
      "cache-control": "public, max-age=3600",
    },
  });
}

async function resolveCacheInfo(env: Env): Promise<string> {
  const memHit = memory.get(CACHE_INFO_KV_KEY);
  if (memHit !== undefined) return memHit;

  const kvHit = await kv.getText(env, CACHE_INFO_KV_KEY);
  if (kvHit !== null) {
    memory.set(CACHE_INFO_KV_KEY, kvHit);
    return kvHit;
  }

  const r2Hit = await r2.getText(env, CACHE_INFO_R2_KEY);
  if (r2Hit !== null) {
    memory.set(CACHE_INFO_KV_KEY, r2Hit);
    return r2Hit;
  }

  // 終端フォールバック: publish で nix-cache-info を上げていない場合でも cache として機能させる。
  const priority = env.CACHE_INFO_PRIORITY ?? "30";
  return `StoreDir: /nix/store\nWantMassQuery: 1\nPriority: ${priority}\n`;
}
