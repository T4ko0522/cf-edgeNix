import type { Env } from "../types";
import * as r2 from "../storage/r2";
import { narR2Key } from "../storage/keys";

/**
 * GET|HEAD /nar/<file-hash>.nar.zst
 *
 * 配信は Worker 経由（spec §6.2 で決定）:
 *   Cache API → R2 binding(ReadableStream) → Nix client
 *
 * `.nar.zst` は HTTP の Content-Encoding ではなく、Nix binary cache 上の
 * 圧縮済みファイルとして bytes をそのまま返す（HTTP decompression を効かせない）。
 */
export async function handleNar(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  fileName: string,
): Promise<Response> {
  const key = narR2Key(fileName);
  const cache = caches.default;

  // HEAD 判定を cache.match より前に出す（C4: HEAD + Cache API 順序）。
  if (req.method === "HEAD") {
    const head = await r2.headObject(env, key);
    if (!head) return new Response("not found\n", { status: 404 });
    const headers = baseHeaders(head);
    headers.set("content-length", String(head.size));
    return new Response(null, { status: 200, headers });
  }

  const rangeHeader = req.headers.get("range");

  // G7: Range リクエストは cache.match を完全にスキップする。
  // full 200 が cache に入った後も Range GET は 206 で返す必要がある。
  if (!rangeHeader) {
    // Range なし: edge cache ヒット（immutable・content-addressed なので long TTL）。
    const cached = await cache.match(req);
    if (cached) return cached;
  }

  if (rangeHeader) {
    // size を先取得して satisfiable 判定。
    const head = await r2.headObject(env, key);
    if (!head) return new Response("not found\n", { status: 404 });

    const parsed = parseSingleRange(rangeHeader, head.size);

    if (parsed.kind === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${head.size}` },
      });
    }

    if (parsed.kind === "range") {
      // suffix が size を超える場合はクランプ（RFC 7233: suffix>size は全体を返す）。
      const normalizedRange = normalizeSuffix(parsed.range, head.size);
      const obj = await r2.getObject(env, key, { range: normalizedRange });
      if (!obj) return new Response("not found\n", { status: 404 });

      const headers = baseHeaders(obj);
      // Content-Range は正規化済みの range から計算する（R2 obj.range に依存しない）。
      const { offset, length } = resolveRangeOffsetLength(normalizedRange, head.size);
      headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${head.size}`);
      headers.set("content-length", String(length));
      // 206 はキャッシュに載せない。
      return new Response(obj.body, { status: 206, headers });
    }

    // kind === "ignore": full body フォールバック（Range ヘッダを除いて fetch）。
    // miniflare 対策: getObject 呼び出し時に R2 binding が Range ヘッダを透過させないよう
    // options 指定なし（range オプションを渡さない）で取得する。
    const obj = await r2.getObject(env, key, {});
    if (!obj) return new Response("not found\n", { status: 404 });

    const headers = baseHeaders(obj);
    headers.set("content-length", String(obj.size));

    const res = new Response(obj.body, { status: 200, headers });
    // ignore の full body は cache に格納（200 なので C5 準拠）。
    ctx.waitUntil(cache.put(new Request(req.url), res.clone()));
    return res;
  }

  const obj = await r2.getObject(env, key, {});
  if (!obj) return new Response("not found\n", { status: 404 });

  const headers = baseHeaders(obj);
  headers.set("content-length", String(obj.size));

  const res = new Response(obj.body, { status: 200, headers });

  // full body のみ immutable cache へ（C5）。Range なしリクエストの URL をキーにする。
  ctx.waitUntil(cache.put(new Request(req.url), res.clone()));
  return res;
}

function baseHeaders(obj: R2Object): Headers {
  const headers = new Headers();
  // .nar.zst をそのまま bytes 配信する（compression は内容の一部・C6）。
  headers.set("content-type", "application/x-nix-nar");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  return headers;
}

// ─── Range 解析 ──────────────────────────────────────────────────────────────

/** R2 へ渡す range 型（R2Range の subset として明示）。 */
export type R2RangeValue =
  | { offset: number; length?: number }
  | { suffix: number };

export type ParsedRange =
  | { kind: "range"; range: R2RangeValue }
  | { kind: "unsatisfiable" }
  | { kind: "ignore" };

/** suffix range で size が分かる場合に offset ベースへ正規化する。 */
function normalizeSuffix(range: R2RangeValue, size: number): R2RangeValue {
  if ("suffix" in range) {
    // suffix > size の場合は全体（offset: 0）にクランプ（RFC 7233 §2.1）。
    const clampedSuffix = Math.min(range.suffix, size);
    return { offset: size - clampedSuffix, length: clampedSuffix };
  }
  return range;
}

/** range と total size から { offset, length } に解決する。 */
function resolveRangeOffsetLength(range: R2RangeValue, size: number): { offset: number; length: number } {
  if ("suffix" in range) {
    const clampedSuffix = Math.min(range.suffix, size);
    const offset = size - clampedSuffix;
    return { offset, length: clampedSuffix };
  }
  const offset = range.offset;
  const length = range.length ?? (size - offset);
  return { offset, length };
}

/**
 * Range ヘッダを解析して ParsedRange を返す純粋関数（export・単体テスト対象）。
 *
 * - `bytes=start-end`  → { kind:"range", range:{ offset, length } }
 * - `bytes=start-`     → { kind:"range", range:{ offset } }
 * - `bytes=-suffix`    → { kind:"range", range:{ suffix } }
 * - 解析不能（形式不正）→ { kind:"ignore" }（full 200 フォールバック）
 * - 範囲外（start >= size 等）→ { kind:"unsatisfiable" }（416）
 *   ※ size が指定されている場合のみ satisfiable 判定を行う。
 */
export function parseSingleRange(header: string, size?: number): ParsedRange {
  if (!header.startsWith("bytes=")) return { kind: "ignore" };

  const spec = header.slice("bytes=".length);

  // bytes=-suffix
  if (spec.startsWith("-")) {
    const suffixStr = spec.slice(1);
    if (suffixStr === "") return { kind: "ignore" };
    // 数字のみ受け付ける（小数・非数値は ignore）。
    if (!/^\d+$/.test(suffixStr)) return { kind: "ignore" };
    const suffix = Number(suffixStr);
    if (suffix <= 0) return { kind: "ignore" };
    // Number.MAX_SAFE_INTEGER 超は ignore（修正14）。
    if (suffix > Number.MAX_SAFE_INTEGER) return { kind: "ignore" };
    // suffix が size 以上の場合は全体（unsatisfiable にはしない・RFC 7233 §2.1 でクランプ許容）。
    // handleNar 側で normalizeSuffix によりクランプする。
    return { kind: "range", range: { suffix } };
  }

  // 複数 range（カンマ区切り）は ignore（full 200 フォールバック）（修正14）。
  if (spec.includes(",")) return { kind: "ignore" };

  const dashIdx = spec.indexOf("-");
  if (dashIdx === -1) return { kind: "ignore" };

  const startStr = spec.slice(0, dashIdx);
  const endStr = spec.slice(dashIdx + 1);

  if (startStr === "") return { kind: "ignore" };

  // 数字のみ受け付ける。
  if (!/^\d+$/.test(startStr)) return { kind: "ignore" };
  const start = Number(startStr);
  // Number.MAX_SAFE_INTEGER 超は ignore（修正14）。
  if (start > Number.MAX_SAFE_INTEGER) return { kind: "ignore" };

  // bytes=start-  (open end)
  if (endStr === "") {
    if (size !== undefined && start >= size) return { kind: "unsatisfiable" };
    return { kind: "range", range: { offset: start } };
  }

  // bytes=start-end
  if (!/^\d+$/.test(endStr)) return { kind: "ignore" };
  const end = Number(endStr);
  // Number.MAX_SAFE_INTEGER 超は ignore（修正14）。
  if (end > Number.MAX_SAFE_INTEGER) return { kind: "ignore" };
  if (start > end) return { kind: "ignore" };

  if (size !== undefined) {
    if (start >= size || end >= size) return { kind: "unsatisfiable" };
  }

  return { kind: "range", range: { offset: start, length: end - start + 1 } };
}
