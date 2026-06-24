/**
 * test/nar/range.test.ts
 *
 * `parseSingleRange` の表駆動単体テスト。
 * 受入条件: C2（bytes=start-end の 206）/ C3（suffix / 416 / フォールバック）
 */
import { describe, expect, test } from "vitest";
import { parseSingleRange } from "../../src/handlers/nar";
import type { ParsedRange } from "../../src/handlers/nar";

// ─── ヘルパ型 ────────────────────────────────────────────────────────────────

type Case = {
  label: string;
  header: string;
  size?: number;
  expected: ParsedRange;
};

// ─── テストケース表 ──────────────────────────────────────────────────────────

const cases: Case[] = [
  // ── bytes=start-end ─────────────────────────────────────────────────────
  {
    label: "bytes=0-99 → range { offset:0, length:100 }",
    header: "bytes=0-99",
    expected: { kind: "range", range: { offset: 0, length: 100 } },
  },
  {
    label: "bytes=50-99 size なし → range { offset:50, length:50 }",
    header: "bytes=50-99",
    expected: { kind: "range", range: { offset: 50, length: 50 } },
  },
  {
    label: "bytes=0-49 size=50 → range { offset:0, length:50 }（ちょうど収まる）",
    header: "bytes=0-49",
    size: 50,
    expected: { kind: "range", range: { offset: 0, length: 50 } },
  },
  {
    label: "bytes=0-0 → range { offset:0, length:1 }（最小 1 byte）",
    header: "bytes=0-0",
    expected: { kind: "range", range: { offset: 0, length: 1 } },
  },

  // ── bytes=start- （open end） ────────────────────────────────────────────
  {
    label: "bytes=100- → range { offset:100 }（length なし）",
    header: "bytes=100-",
    expected: { kind: "range", range: { offset: 100 } },
  },
  {
    label: "bytes=0- → range { offset:0 }（先頭から全体）",
    header: "bytes=0-",
    expected: { kind: "range", range: { offset: 0 } },
  },

  // ── bytes=-suffix ────────────────────────────────────────────────────────
  {
    label: "bytes=-500 → range { suffix:500 }（suffix バグ修正の核心）",
    header: "bytes=-500",
    expected: { kind: "range", range: { suffix: 500 } },
  },
  {
    label: "bytes=-1 → range { suffix:1 }（最小 suffix）",
    header: "bytes=-1",
    expected: { kind: "range", range: { suffix: 1 } },
  },

  // ── unsatisfiable（size 指定時のみ判定） ─────────────────────────────────
  {
    label: "bytes=50-99 size=50 → unsatisfiable（start=50 >= size=50）",
    header: "bytes=50-99",
    size: 50,
    expected: { kind: "unsatisfiable" },
  },
  {
    label: "bytes=0-99 size=50 → unsatisfiable（end=99 >= size=50）",
    header: "bytes=0-99",
    size: 50,
    expected: { kind: "unsatisfiable" },
  },
  {
    label: "bytes=100- size=50 → unsatisfiable（start=100 >= size=50）",
    header: "bytes=100-",
    size: 50,
    expected: { kind: "unsatisfiable" },
  },

  // ── ignore（解析不能 → full 200 フォールバック） ──────────────────────────
  {
    label: "bytes=abc → ignore（数値でない）",
    header: "bytes=abc",
    expected: { kind: "ignore" },
  },
  {
    label: "bytes=- → ignore（start も end も空）",
    header: "bytes=-",
    expected: { kind: "ignore" },
  },
  {
    label: "bytes= → ignore（値なし）",
    header: "bytes=",
    expected: { kind: "ignore" },
  },
  {
    label: "bytes=1-abc → ignore（end が数値でない）",
    header: "bytes=1-abc",
    expected: { kind: "ignore" },
  },
  {
    label: "Range ヘッダに bytes= プレフィクスなし → ignore",
    header: "items=0-99",
    expected: { kind: "ignore" },
  },
  {
    label: "空文字列 → ignore",
    header: "",
    expected: { kind: "ignore" },
  },
  {
    label: "bytes=10-5 → ignore（start > end は不正）",
    header: "bytes=10-5",
    expected: { kind: "ignore" },
  },

  // ── 追加境界値テスト ──────────────────────────────────────────────────────
  // suffix > size のクランプ確認（G7: suffix > size の場合は range として渡す）
  {
    label: "bytes=-500 size=100 → suffix=500 として range（suffix>size でもクランプしない・R2 に委譲）",
    header: "bytes=-500",
    size: 100,
    // parseSingleRange は suffix>size でも range として返す（クランプは handleNar 側）
    expected: { kind: "range", range: { suffix: 500 } },
  },
  // bytes=-0 → suffix が 0 → ignore
  {
    label: "bytes=-0 → ignore（suffix=0 は意味なし）",
    header: "bytes=-0",
    expected: { kind: "ignore" },
  },
  // 先頭空白
  {
    label: " bytes=0-9 （先頭空白）→ ignore（bytes= プレフィクス不正）",
    header: " bytes=0-9",
    expected: { kind: "ignore" },
  },
  // 複数 range（カンマ区切り）は ignore（full 200 フォールバック）（修正14）。
  {
    label: "bytes=0-1,2-3 → ignore（複数 range は ignore）",
    header: "bytes=0-1,2-3",
    expected: { kind: "ignore" },
  },
  // start=0, end=0, size=0 → unsatisfiable
  {
    label: "bytes=0-0 size=0 → unsatisfiable（size=0 なので start>=size）",
    header: "bytes=0-0",
    size: 0,
    expected: { kind: "unsatisfiable" },
  },
  // bytes= 直後がダッシュのみ
  {
    label: "bytes=-- → ignore（負数風の入力）",
    header: "bytes=--",
    expected: { kind: "ignore" },
  },
  // 大きな数値（Number.MAX_SAFE_INTEGER 境界）
  {
    label: "bytes=0-9007199254740991 size なし → range（Number.MAX_SAFE_INTEGER として解析）",
    header: "bytes=0-9007199254740991",
    expected: { kind: "range", range: { offset: 0, length: 9007199254740992 } },
  },
  // start と end が同じ（1 byte）
  {
    label: "bytes=5-5 size=10 → range 1 byte",
    header: "bytes=5-5",
    size: 10,
    expected: { kind: "range", range: { offset: 5, length: 1 } },
  },
  // end が size に等しい（境界 off-by-one 確認）
  {
    label: "bytes=0-10 size=10 → unsatisfiable（end=10 >= size=10）",
    header: "bytes=0-10",
    size: 10,
    expected: { kind: "unsatisfiable" },
  },
  // end が size-1（ちょうど収まる）
  {
    label: "bytes=0-9 size=10 → range { offset:0, length:10 }（ちょうど全体）",
    header: "bytes=0-9",
    size: 10,
    expected: { kind: "range", range: { offset: 0, length: 10 } },
  },
];

// ─── テスト実行 ──────────────────────────────────────────────────────────────

describe("parseSingleRange", () => {
  for (const c of cases) {
    test(c.label, () => {
      const result = parseSingleRange(c.header, c.size);
      expect(result).toEqual(c.expected);
    });
  }
});
