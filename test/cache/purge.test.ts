/**
 * test/cache/purge.test.ts
 *
 * Workers Cache タグ purge ヘルパ（src/cache/purge.ts）の unit テスト。
 * - purgerFrom: ExecutionContext からの feature-detect（非対応環境では null）
 * - purgeTags: chunk 分割・非対応時 0・失敗時も継続する best-effort 動作
 */
import { describe, expect, test } from "vitest";
import { purgerFrom, purgeTags, type TagPurger } from "../../src/cache/purge";

function makePurger(calls: string[][], opts?: { failOnChunk?: number; successFalseOnChunk?: number }) {
  let n = 0;
  const purger: TagPurger = {
    async purge({ tags }) {
      const idx = n++;
      if (opts?.failOnChunk === idx) throw new Error("purge boom");
      calls.push(tags);
      if (opts?.successFalseOnChunk === idx) return { success: false, errors: [{ message: "rate limited" }] };
      return { success: true };
    },
  };
  return purger;
}

describe("purgerFrom", () => {
  test("ctx.cache.purge が関数なら purger を返す", () => {
    const ctx = { cache: { purge: async () => ({}) } } as unknown as ExecutionContext;
    expect(purgerFrom(ctx)).not.toBeNull();
  });

  test("ctx.cache が無い（ローカル dev / test ランタイム）なら null", () => {
    const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
    expect(purgerFrom(ctx)).toBeNull();
  });

  test("ctx が undefined なら null", () => {
    expect(purgerFrom(undefined)).toBeNull();
  });
});

describe("purgeTags", () => {
  test("purger が null なら 0 を返し何もしない", async () => {
    expect(await purgeTags(null, ["narinfo:aaa"])).toBe(0);
  });

  test("空タグなら 0", async () => {
    const calls: string[][] = [];
    expect(await purgeTags(makePurger(calls), [])).toBe(0);
    expect(calls).toEqual([]);
  });

  test("100 件以下は 1 回の purge にまとめる", async () => {
    const calls: string[][] = [];
    const tags = Array.from({ length: 100 }, (_, i) => `narinfo:${i}`);
    expect(await purgeTags(makePurger(calls), tags)).toBe(100);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(tags);
  });

  test("101 件は 100 + 1 に chunk 分割する", async () => {
    const calls: string[][] = [];
    const tags = Array.from({ length: 101 }, (_, i) => `nar:${i}`);
    expect(await purgeTags(makePurger(calls), tags)).toBe(101);
    expect(calls.length).toBe(2);
    expect(calls[0]?.length).toBe(100);
    expect(calls[1]?.length).toBe(1);
  });

  test("chunk が throw しても残りの chunk を続行する（best-effort）", async () => {
    const calls: string[][] = [];
    const tags = Array.from({ length: 250 }, (_, i) => `t:${i}`);
    // 2 番目の chunk（index 1）が throw
    const attempted = await purgeTags(makePurger(calls, { failOnChunk: 1 }), tags);
    // 100 + (fail) + 50 = 150
    expect(attempted).toBe(150);
    expect(calls.length).toBe(2);
  });

  test("success:false が返っても throw せず継続する", async () => {
    const calls: string[][] = [];
    const tags = Array.from({ length: 150 }, (_, i) => `t:${i}`);
    const attempted = await purgeTags(makePurger(calls, { successFalseOnChunk: 0 }), tags);
    // success:false の chunk は attempted に数えない
    expect(attempted).toBe(50);
    expect(calls.length).toBe(2);
  });
});
