/**
 * L0: Worker isolate ローカルのメモリキャッシュ。
 *
 * 直近アクセスされた narinfo / nix-cache-info を一時保持する速度層（spec §6.1）。
 * isolate ごとに独立し、再起動で消える揮発キャッシュ。正本ではない。
 * NAR 本体は巨大（isolate は 128MB 制限）なのでここには載せない。
 */
const MAX_ENTRIES = 512;

/** 挿入順 Map を使った素朴な LRU。値は narinfo / cache-info のテキスト。 */
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

/** メモリキャッシュからキーを破棄する。GC unpublish 時に narinfo を即時 stale 化するために使う。他 isolate は不可侵なので best-effort。 */
export function del(key: string): void {
  store.delete(key);
}
