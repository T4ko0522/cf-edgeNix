/**
 * test/integration/nar-size-cache.test.ts
 *
 * Range リクエストの HEAD 省略最適化（narsize L0 キャッシュ）の統合テスト。
 * NAR は content-addressed + immutable なので size は不変 = stale リスクなしで
 * isolate メモリにキャッシュでき、Range 経路の R2 2 op（HEAD+GET）を 1 op に減らせる。
 *
 * 注意: memory は isolate グローバルなため、このファイル専用の fileName を使う。
 */
import { describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import { handleNar } from "../../src/handlers/nar";
import * as memory from "../../src/cache/memory";
import type { Env } from "../../src/types";

function getEnv() {
  return env as unknown as Env;
}

const CONTENT = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // 10 bytes

async function putNar(fileName: string) {
  await getEnv().NAR_BUCKET.put(`nar/${fileName}`, CONTENT);
}

describe("narsize L0 キャッシュ", () => {
  test("full GET 後に size が L0 に載る", async () => {
    const f = "sizecache01.nar.zst";
    await putNar(f);
    const res = await handleNar(new Request(`https://example.com/nar/${f}`), getEnv(), f);
    expect(res.status).toBe(200);
    expect(memory.get(`narsize:${f}`)).toBe("10");
  });

  test("HEAD 後に size が L0 に載る", async () => {
    const f = "sizecache02.nar.zst";
    await putNar(f);
    const res = await handleNar(
      new Request(`https://example.com/nar/${f}`, { method: "HEAD" }),
      getEnv(),
      f,
    );
    expect(res.status).toBe(200);
    expect(memory.get(`narsize:${f}`)).toBe("10");
  });

  test("Range GET（cold）でも size が L0 に載り、206 が正しく返る", async () => {
    const f = "sizecache03.nar.zst";
    await putNar(f);
    const res = await handleNar(
      new Request(`https://example.com/nar/${f}`, { headers: { range: "bytes=0-4" } }),
      getEnv(),
      f,
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-4/10");
    expect(memory.get(`narsize:${f}`)).toBe("10");
  });

  test("satisfiable な Range では headObject を呼ばない（キャッシュ値が使われる）", async () => {
    // white-box: 実オブジェクト（10 bytes）と食い違う size=5 を L0 に注入する。
    // HEAD を呼ぶ実装なら Content-Range の分母は実 size=10 になるが、
    // L0 の size=5 を使う実装なら bytes 0-2/5 になる。
    // content-addressed 運用ではこの食い違いは発生しない（テスト専用の状況）。
    const f = "sizecache04.nar.zst";
    await putNar(f);
    memory.set(`narsize:${f}`, "5");

    const res = await handleNar(
      new Request(`https://example.com/nar/${f}`, { headers: { range: "bytes=0-2" } }),
      getEnv(),
      f,
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-2/5");
  });

  test("size が L0 にあり object が GC 済みなら 404（安全側に倒れる）", async () => {
    const f = "sizecache05.nar.zst";
    memory.set(`narsize:${f}`, "10"); // object は R2 に存在しない
    const res = await handleNar(
      new Request(`https://example.com/nar/${f}`, { headers: { range: "bytes=0-4" } }),
      getEnv(),
      f,
    );
    expect(res.status).toBe(404);
  });

  test("キャッシュ size で unsatisfiable な Range は R2 を再検証する（Codex 指摘）", async () => {
    // stale な size=5 を注入し、実オブジェクトは 10 bytes。bytes=7-9 はキャッシュ値では
    // unsatisfiable だが、再検証（HEAD）で実 size=10 が得られれば 206 が正しい。
    const f = "sizecache06.nar.zst";
    await putNar(f);
    memory.set(`narsize:${f}`, "5");

    const res = await handleNar(
      new Request(`https://example.com/nar/${f}`, { headers: { range: "bytes=7-9" } }),
      getEnv(),
      f,
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 7-9/10");
    // 再検証後の size が L0 に反映される
    expect(memory.get(`narsize:${f}`)).toBe("10");
  });

  test("size が L0 にあり object が GC 済み + unsatisfiable Range → 416 ではなく 404（Codex 指摘）", async () => {
    const f = "sizecache07.nar.zst";
    memory.set(`narsize:${f}`, "10"); // object は R2 に存在しない
    const res = await handleNar(
      new Request(`https://example.com/nar/${f}`, { headers: { range: "bytes=100-199" } }),
      getEnv(),
      f,
    );
    expect(res.status).toBe(404);
  });
});
