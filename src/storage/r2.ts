import type { Env } from "../types";

/** R2 からテキスト object（narinfo / nix-cache-info）を取得する。無ければ null。 */
export async function getText(env: Env, key: string): Promise<string | null> {
  const obj = await env.NAR_BUCKET.get(key);
  if (!obj) return null;
  return await obj.text();
}

/**
 * R2 から NAR object body を取得する（ReadableStream のまま扱う）。
 * Worker 上で NAR を丸ごとメモリに載せない（isolate は 128MB 制限・spec §6.2）。
 * Range 付き取得など部分取得は r2 binding の options をそのまま透過させる。
 */
export async function getObject(
  env: Env,
  key: string,
  options?: R2GetOptions,
): Promise<R2ObjectBody | null> {
  const obj = await env.NAR_BUCKET.get(key, options);
  // Range 不一致などで body を持たない R2Object が返る場合は呼び出し側で扱う。
  if (!obj || !("body" in obj)) return null;
  return obj as R2ObjectBody;
}

/** HEAD 用: body を読まずにメタデータ（size / etag）だけ取得する。 */
export async function headObject(env: Env, key: string): Promise<R2Object | null> {
  return await env.NAR_BUCKET.head(key);
}

/** R2 object を削除する。存在しない key は R2 側で no-op。 */
export async function deleteObject(env: Env, key: string): Promise<void> {
  await env.NAR_BUCKET.delete(key);
}

/** R2 object を 1000 件ずつまとめて削除する。 */
export async function deleteObjects(env: Env, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    if (chunk.length === 0) continue;
    await env.NAR_BUCKET.delete(chunk);
  }
}
