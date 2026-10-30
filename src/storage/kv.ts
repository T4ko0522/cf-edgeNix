import type { Env } from "../types";

/** nix-cache-info の任意のコピーを読む。未登録なら呼び出し側で R2 を参照する。 */
export async function getText(env: Env, key: string): Promise<string | null> {
  return await env.META_KV.get(key, "text");
}
