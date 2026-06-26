import type { Env } from "../types";

/**
 * KV は narinfo / nix-cache-info の速度層（spec §6.1）。
 *
 *   「KVは真実ではなく、速い噂。真実はR2とD1に置く。」
 *
 * 重要: KV miss を D1 へ落とさないこと。nixos-rebuild は1回で大量の narinfo を
 * 引くため、KV miss が D1 に雪崩れ込むと control plane が hot metadata server に
 * 転落する。miss は R2 から復元する。
 */
export async function getText(env: Env, key: string): Promise<string | null> {
  return await env.META_KV.get(key, "text");
}

/** publish 後の warming で narinfo / cache-info を流し込む（spec §9）。 */
export async function putText(env: Env, key: string, value: string): Promise<void> {
  await env.META_KV.put(key, value);
}

/** KV から text entry を削除する。存在しない key は KV 側で no-op。 */
export async function deleteText(env: Env, key: string): Promise<void> {
  await env.META_KV.delete(key);
}
