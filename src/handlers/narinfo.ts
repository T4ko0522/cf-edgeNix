import type { Env } from "../types";
import * as kv from "../storage/kv";
import * as r2 from "../storage/r2";
import { narinfoKVKey, narinfoR2Key } from "../storage/keys";

/**
 * GET /<store-hash>.narinfo
 *
 * read path: Workers Cache(edge) → KV → R2(deterministic key) → 404（spec §6.1 / §10）。
 * D1 は挟まない。KV miss を D1 へ落とさず R2 から復元する。
 *
 * edge 層は Workers Cache（wrangler.toml [cache]）が担う。ヒット時は Worker 自体が
 * 起動しないため、isolate ローカルの L0 メモリキャッシュは廃止した（実効ヒット率が
 * ほぼゼロになる一方、GC 後の isolate stale だけが残るため）。
 *
 * 404 も短 TTL で edge にキャッシュする（negative cache）。nixos-rebuild は存在しない
 * store path を大量に引くため、これがないと miss が毎回 KV/R2 に到達し
 * R2 Class B / KV read を浪費する。Cache-Tag は positive / negative で
 * `narinfo:<storeHash>` を共有し、publish / GC の purge で両方を同時に消せる。
 */
export async function handleNarinfo(env: Env, storeHash: string): Promise<Response> {
  const kvHit = await kv.getText(env, narinfoKVKey(storeHash));
  if (kvHit !== null) return narinfoResponse(kvHit, storeHash);

  const r2Hit = await r2.getText(env, narinfoR2Key(storeHash));
  if (r2Hit !== null) {
    // NOTE: ここで KV を書き戻す read-through warming も選択肢だが、
    //       publish 側 warming（spec §9）に一本化するため read path では書かない。
    return narinfoResponse(r2Hit, storeHash);
  }

  return new Response("not found\n", {
    status: 404,
    headers: {
      "cache-control": "public, max-age=60",
      "cache-tag": `narinfo-miss,narinfo:${storeHash}`,
    },
  });
}

function narinfoResponse(body: string, storeHash: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/x-nix-narinfo",
      "cache-control": "public, max-age=3600",
      "cache-tag": `narinfo,narinfo:${storeHash}`,
    },
  });
}
