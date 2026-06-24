import type { Env } from "../types";
import * as memory from "../cache/memory";
import * as kv from "../storage/kv";
import * as r2 from "../storage/r2";
import { narinfoKVKey, narinfoR2Key } from "../storage/keys";

/**
 * GET /<store-hash>.narinfo
 *
 * read path: memory → KV → R2(deterministic key) → 404（spec §6.1 / §10）。
 * D1 は挟まない。KV miss を D1 へ落とさず R2 から復元する。
 */
export async function handleNarinfo(env: Env, storeHash: string): Promise<Response> {
  const memKey = narinfoKVKey(storeHash);

  const memHit = memory.get(memKey);
  if (memHit !== undefined) return narinfoResponse(memHit);

  const kvHit = await kv.getText(env, memKey);
  if (kvHit !== null) {
    memory.set(memKey, kvHit);
    return narinfoResponse(kvHit);
  }

  const r2Hit = await r2.getText(env, narinfoR2Key(storeHash));
  if (r2Hit !== null) {
    memory.set(memKey, r2Hit);
    // NOTE: ここで KV を書き戻す read-through warming も選択肢だが、
    //       publish 側 warming（spec §9）に一本化するため read path では書かない。
    return narinfoResponse(r2Hit);
  }

  return new Response("not found\n", { status: 404 });
}

function narinfoResponse(body: string): Response {
  // 修正15: x-edgenix-source ヘッダを削除（内部キャッシュ階層の外部露出防止）。
  return new Response(body, {
    headers: {
      "content-type": "text/x-nix-narinfo",
      "cache-control": "public, max-age=3600",
    },
  });
}
