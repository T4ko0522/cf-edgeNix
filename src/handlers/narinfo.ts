import type { Env } from "../types";
import * as r2 from "../storage/r2";
import { narinfoR2Key } from "../storage/keys";

/**
 * GET /<store-hash>.narinfo
 *
 * read path: Workers Cache(edge) → R2(deterministic key) → 404。
 * narinfo の取得は R2 の正本のみを参照し、KV / D1 は挟まない。
 *
 * edge 層は Workers Cache（wrangler.toml [cache]）が担う。ヒット時は Worker 自体が
 * 起動しないため、isolate ローカルの L0 メモリキャッシュは廃止した（実効ヒット率が
 * ほぼゼロになる一方、GC 後の isolate stale だけが残るため）。
 *
 * 404 も短 TTL で edge にキャッシュする（negative cache）。nixos-rebuild は存在しない
 * store path を大量に引くため、これがないと miss が毎回 R2 に到達し
 * R2 Class B を浪費する。Cache-Tag は positive / negative で
 * `narinfo:<storeHash>` を共有し、publish / GC の purge で両方を同時に消せる。
 */
export async function handleNarinfo(env: Env, storeHash: string): Promise<Response> {
  const r2Hit = await r2.getText(env, narinfoR2Key(storeHash));
  if (r2Hit !== null) return narinfoResponse(r2Hit, storeHash);

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
