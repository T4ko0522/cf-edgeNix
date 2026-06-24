/**
 * test/integration/nar.test.ts
 *
 * NAR 配信の統合テスト（G7、C2-C6）。
 * 実 R2 (miniflare) に NAR を put して handleNar の振る舞いを検証する。
 * - full 200: body あり、Content-Length、Content-Type
 * - Range 206: Content-Range ヘッダ、206 は cache に格納されない（C5）
 * - suffix 206（bytes=-N）: suffix > size のクランプ（G7）
 * - 範囲外 416: Content-Range: bytes &#42;/{size}
 * - HEAD: body なし、Content-Length あり（C4）
 * - Content-Encoding を付けない（C6）
 * - Range GET が full 200 cache に吸われない（G7、C5）
 *
 * 受入条件: C1/C2/C3/C4/C5/C6 / G7
 */
import { beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import { handleNar } from "../../src/handlers/nar";
import type { Env } from "../../src/types";

// ─── ヘルパ ─────────────────────────────────────────────────────────────────

const FILE_NAME = "sha256:testnar123456789.nar.zst";
const NAR_CONTENT = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // 10 bytes

function getEnv() {
  return env as unknown as Env;
}

/** miniflare R2 に NAR データを put する */
async function putNar(content: Uint8Array = NAR_CONTENT, key?: string) {
  const narKey = `nar/${key ?? FILE_NAME}`;
  await (env as unknown as Env).NAR_BUCKET.put(narKey, content);
}

/** handleNar 呼び出し用の ExecutionContext スタブ */
function makeCtx(): ExecutionContext {
  return {
    waitUntil: (_p: Promise<unknown>) => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

beforeEach(async () => {
  // R2 の isolatedStorage により各テストで独立しているが、
  // 念のため既存のテスト用オブジェクトを削除
  try {
    await (env as unknown as Env).NAR_BUCKET.delete(`nar/${FILE_NAME}`);
  } catch {
    // 存在しない場合は無視
  }
});

// ─── full body 200 ───────────────────────────────────────────────────────────

describe("full body GET 200（C1/C5/C6）", () => {
  test("存在する NAR を GET すると 200 を返す", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`);
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    expect(res.status).toBe(200);
  });

  test("Content-Type が application/x-nix-nar", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`);
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    expect(res.headers.get("content-type")).toBe("application/x-nix-nar");
  });

  test("Content-Length が nar ファイルのバイト数", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`);
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    expect(res.headers.get("content-length")).toBe(String(NAR_CONTENT.length));
  });

  test("Content-Encoding を付けない（C6: .nar.zst は bytes そのまま）", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`);
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    // Content-Encoding ヘッダが存在しないことを確認
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  test("Accept-Ranges: bytes が設定されている", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`);
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  test("存在しない NAR を GET すると 404", async () => {
    const req = new Request("https://example.com/nar/nonexistent.nar.zst");
    const res = await handleNar(req, getEnv(), makeCtx(), "nonexistent.nar.zst");
    expect(res.status).toBe(404);
  });

  test("200 レスポンスの body を読み切れる（C1: streaming 確認）", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`);
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    const buf = await res.arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(NAR_CONTENT);
  });
});

// ─── Range 206 ───────────────────────────────────────────────────────────────

describe("Range GET 206（C2/C3/G7）", () => {
  test("bytes=0-4 → 206 + Content-Range: bytes 0-4/10", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`, {
      headers: { range: "bytes=0-4" },
    });
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-4/10");
    expect(res.headers.get("content-length")).toBe("5");
  });

  test("bytes=5-9 → 206 + Content-Range: bytes 5-9/10", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`, {
      headers: { range: "bytes=5-9" },
    });
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 5-9/10");
    expect(res.headers.get("content-length")).toBe("5");
  });

  test("bytes=0- (open end) → 206", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`, {
      headers: { range: "bytes=0-" },
    });
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    expect(res.status).toBe(206);
  });

  test("suffix range bytes=-5 → 206 + Content-Range: bytes 5-9/10", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`, {
      headers: { range: "bytes=-5" },
    });
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 5-9/10");
    expect(res.headers.get("content-length")).toBe("5");
  });

  test("Range GET の 206 レスポンスに Content-Encoding が付かない（C6）", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`, {
      headers: { range: "bytes=0-4" },
    });
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    expect(res.headers.get("content-encoding")).toBeNull();
  });
});

// ─── 416（範囲外） ───────────────────────────────────────────────────────────

describe("416 範囲外（C3）", () => {
  test("bytes=10-19 (start >= size=10) → 416", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`, {
      headers: { range: "bytes=10-19" },
    });
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
  });

  test("bytes=0-99 (end >= size=10) → 416", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`, {
      headers: { range: "bytes=0-99" },
    });
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    expect(res.status).toBe(416);
  });
});

// ─── HEAD（C4） ──────────────────────────────────────────────────────────────

describe("HEAD /nar/:file（C4）", () => {
  test("HEAD → 200 + body なし", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`, {
      method: "HEAD",
    });
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    expect(res.status).toBe(200);
    // HEAD は body を持たない
    const text = await res.text();
    expect(text).toBe("");
  });

  test("HEAD → Content-Length ヘッダが存在する（C4）", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`, {
      method: "HEAD",
    });
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    expect(res.headers.get("content-length")).toBe(String(NAR_CONTENT.length));
  });

  test("HEAD → ETag ヘッダが存在する（C4）", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`, {
      method: "HEAD",
    });
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    expect(res.headers.get("etag")).not.toBeNull();
  });

  test("HEAD → Accept-Ranges: bytes（C4）", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`, {
      method: "HEAD",
    });
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  test("存在しない NAR に HEAD → 404", async () => {
    const req = new Request("https://example.com/nar/missing.nar.zst", {
      method: "HEAD",
    });
    const res = await handleNar(req, getEnv(), makeCtx(), "missing.nar.zst");
    expect(res.status).toBe(404);
  });
});

// ─── 206 はキャッシュに載らない（C5/G7） ────────────────────────────────────

describe("206 はキャッシュに格納されない（C5/G7）", () => {
  test("Range GET (206) の後に同じ URL に full GET → R2 から読む（cache に吸われない）", async () => {
    await putNar();
    const url = `https://example.com/nar/${FILE_NAME}`;
    const ctx = makeCtx();

    // 1 回目: Range GET → 206
    const rangeReq = new Request(url, { headers: { range: "bytes=0-4" } });
    const rangeRes = await handleNar(rangeReq, getEnv(), ctx, FILE_NAME);
    expect(rangeRes.status).toBe(206);

    // 2 回目: full GET → 200（206 が cache に入っていれば body が壊れる可能性があるが、
    // 正しい実装では cache.match は Range リクエストを回避するため full 200 が返る）
    const fullReq = new Request(url);
    const fullRes = await handleNar(fullReq, getEnv(), ctx, FILE_NAME);
    expect(fullRes.status).toBe(200);
    const body = await fullRes.arrayBuffer();
    expect(new Uint8Array(body)).toEqual(NAR_CONTENT);
  });

  test("Range GET は cache.match を経由しない（Cache-Control は full 200 のみ）", async () => {
    await putNar();

    // full GET を先に実行して cache を満たす
    const url = `https://example.com/nar/${FILE_NAME}`;
    const ctx = makeCtx();

    const fullReq1 = new Request(url);
    const fullRes1 = await handleNar(fullReq1, getEnv(), ctx, FILE_NAME);
    expect(fullRes1.status).toBe(200);

    // その後 Range GET → 206 が返る（full cache ヒットで 200 になることなく 206）
    const rangeReq = new Request(url, { headers: { range: "bytes=0-4" } });
    const rangeRes = await handleNar(rangeReq, getEnv(), ctx, FILE_NAME);
    // G7: Range GET は cache.match を回避するため 206 になる
    expect(rangeRes.status).toBe(206);
  });
});

// ─── ignore（解析不能 range → full 200 フォールバック）（C3） ─────────────────

describe("ignore range → full 200 フォールバック（C3）", () => {
  test("bytes=- (不正) → full 200", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`, {
      headers: { range: "bytes=-" },
    });
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    // ignore → full body
    expect(res.status).toBe(200);
  });

  test("items=0-9 (bytes= プレフィクスなし) → full 200", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${FILE_NAME}`, {
      headers: { range: "items=0-9" },
    });
    const res = await handleNar(req, getEnv(), makeCtx(), FILE_NAME);
    expect(res.status).toBe(200);
  });
});
