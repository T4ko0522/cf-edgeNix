/**
 * Nix binary cache のリクエストをルーティングする（spec §10）。
 *
 *   GET  /nix-cache-info
 *   GET  /<store-hash>.narinfo
 *   GET|HEAD /nar/<file-hash>.nar.zst   ... /nar/ 配下の任意ファイル名
 *   /api/* は index.ts で hono apiApp に委譲するためここでは not-found。
 *
 * NAR fileName は allowlist 形式制約: `^[0-9a-z]+\.nar(\.(xz|zst|gz|br))?$`（修正10）。
 * 違反（path traversal・制御文字・不正拡張子）は not-found(404) を返す。
 */
export type Route =
  | { kind: "cache-info" }
  | { kind: "narinfo"; storeHash: string }
  | { kind: "nar"; fileName: string }
  | { kind: "not-found" };

const NAR_FILENAME_RE = /^[0-9a-z]+\.nar(\.(xz|zst|gz|br))?$/;

export function route(pathname: string): Route {
  if (pathname === "/nix-cache-info") return { kind: "cache-info" };

  if (pathname.startsWith("/nar/")) {
    const fileName = pathname.slice("/nar/".length);
    // allowlist: base32 hash + 圧縮拡張子のみ許可（修正10）。
    if (NAR_FILENAME_RE.test(fileName)) {
      return { kind: "nar", fileName };
    }
    return { kind: "not-found" };
  }

  // /<store-hash>.narinfo（サブパスなしのトップレベルのみ）
  const narinfo = /^\/([0-9a-z]+)\.narinfo$/.exec(pathname);
  if (narinfo?.[1]) return { kind: "narinfo", storeHash: narinfo[1] };

  return { kind: "not-found" };
}
