/**
 * Workers Cache の Cache-Tag purge ヘルパ（best-effort）。
 *
 * read path のレスポンスには Cache-Tag（narinfo:<storeHash> / nar:<fileName> /
 * cache-info）が付いており、GC / publish finalize はここを通して edge の
 * エントリ（negative cache 含む）を無効化する。
 *
 * purge は KV 削除や R2 削除と同格の best-effort として扱う:
 * - ctx.cache.purge が無いランタイム（ローカル dev / vitest の miniflare）ではスキップ
 * - 失敗（throw / success:false）は warn ログのみで処理を止めない
 *   （タグ purge がプラン制限で使えない場合も degraded 動作として受容する）
 */

export type TagPurger = {
  purge(options: { tags: string[] }): Promise<{ success?: boolean; errors?: unknown[] } | void>;
};

/** 1 回の purge 呼び出しに載せる最大タグ数。 */
const CHUNK_SIZE = 100;

/**
 * ExecutionContext から purger を feature-detect する。非対応ランタイムでは null。
 * hono / workers-types で ExecutionContext の型定義が揺れるため引数は unknown で受ける。
 */
export function purgerFrom(ctx: unknown): TagPurger | null {
  const cache = (ctx as { cache?: { purge?: unknown } } | undefined)?.cache;
  if (cache && typeof cache.purge === "function") return cache as TagPurger;
  return null;
}

/**
 * タグ群を CHUNK_SIZE ごとに分割して purge する。
 * 戻り値は purge が成功したタグ数（非対応・空入力なら 0）。
 */
export async function purgeTags(purger: TagPurger | null, tags: string[]): Promise<number> {
  if (purger === null || tags.length === 0) return 0;

  let purged = 0;
  for (let i = 0; i < tags.length; i += CHUNK_SIZE) {
    const chunk = tags.slice(i, i + CHUNK_SIZE);
    try {
      const result = await purger.purge({ tags: chunk });
      if (result && result.success === false) {
        console.warn(`[cache] tag purge rejected (non-fatal): ${JSON.stringify(result.errors ?? [])}`);
        continue;
      }
      purged += chunk.length;
    } catch (e) {
      console.warn(`[cache] tag purge failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return purged;
}
