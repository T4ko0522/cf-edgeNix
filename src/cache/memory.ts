/**
 * isolate ローカルの汎用 LRU メモリキャッシュ。
 *
 * かつては narinfo / nix-cache-info の L0 層だったが、Workers Cache（edge）導入で
 * メタデータの L0 は廃止した（edge ヒット時は Worker が起動せず参照されないため）。
 * 現在の用途は NAR size のキャッシュ（Range リクエストの HEAD 省略）のみ。
 * Range 応答（206）は Workers Cache に保存されないため、isolate メモリが唯一の節約手段。
 *
 * isolate ごとに独立し、再起動で消える揮発キャッシュ。content-addressed で不変な
 * 値だけを載せること（TTL を持たないため、可変な値は stale になる）。
 */
const MAX_ENTRIES = 512;

/** 挿入順 Map を使った素朴な LRU。 */
const store = new Map<string, string>();

export function get(key: string): string | undefined {
  const hit = store.get(key);
  if (hit === undefined) return undefined;
  // touch: 末尾へ移動して LRU を維持。
  store.delete(key);
  store.set(key, hit);
  return hit;
}

export function set(key: string, value: string): void {
  if (store.has(key)) store.delete(key);
  store.set(key, value);
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}
