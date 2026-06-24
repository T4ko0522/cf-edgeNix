/**
 * test/schemas/params.test.ts
 *
 * src/schemas/params.ts の zod schema 単体テスト（境界値テスト）。
 * 受入条件: B4/F1
 */
import { describe, expect, test } from "vitest";
import { HostSchema, BuildIdSchema, StoreHashSchema } from "../../src/schemas/params";

// ─── HostSchema ──────────────────────────────────────────────────────────────

describe("HostSchema", () => {
  describe("有効な値", () => {
    test("英数字のみ", () => {
      expect(HostSchema.safeParse("myhost").success).toBe(true);
    });

    test("ドット・ハイフン・アンダースコアを含む", () => {
      expect(HostSchema.safeParse("my-host.example.com").success).toBe(true);
    });

    test("1 文字（最小）", () => {
      expect(HostSchema.safeParse("a").success).toBe(true);
    });

    test("数字のみ", () => {
      expect(HostSchema.safeParse("123").success).toBe(true);
    });

    test("アンダースコアのみ", () => {
      expect(HostSchema.safeParse("_").success).toBe(true);
    });
  });

  describe("無効な値", () => {
    test("空文字 → 失敗", () => {
      expect(HostSchema.safeParse("").success).toBe(false);
    });

    test("スペースを含む → 失敗", () => {
      expect(HostSchema.safeParse("host name").success).toBe(false);
    });

    test("スラッシュを含む → 失敗", () => {
      expect(HostSchema.safeParse("host/name").success).toBe(false);
    });

    test("@記号を含む → 失敗", () => {
      expect(HostSchema.safeParse("host@domain").success).toBe(false);
    });

    test("日本語を含む → 失敗", () => {
      expect(HostSchema.safeParse("ホスト").success).toBe(false);
    });

    test("# を含む → 失敗", () => {
      expect(HostSchema.safeParse("host#name").success).toBe(false);
    });

    test("改行を含む → 失敗", () => {
      expect(HostSchema.safeParse("host\nname").success).toBe(false);
    });
  });
});

// ─── BuildIdSchema ────────────────────────────────────────────────────────────

describe("BuildIdSchema", () => {
  describe("有効な値", () => {
    test("英数字のみ", () => {
      expect(BuildIdSchema.safeParse("build001").success).toBe(true);
    });

    test("ハイフンを含む", () => {
      expect(BuildIdSchema.safeParse("build-001-rev2").success).toBe(true);
    });

    test("UUID 形式", () => {
      expect(BuildIdSchema.safeParse("550e8400-e29b-41d4-a716-446655440000").success).toBe(true);
    });

    test("1 文字（最小）", () => {
      expect(BuildIdSchema.safeParse("a").success).toBe(true);
    });

    test("先頭がハイフン", () => {
      // BuildIdSchema は ^[a-zA-Z0-9-]+$ なので先頭ハイフンは有効
      expect(BuildIdSchema.safeParse("-build").success).toBe(true);
    });
  });

  describe("無効な値", () => {
    test("空文字 → 失敗", () => {
      expect(BuildIdSchema.safeParse("").success).toBe(false);
    });

    test("アンダースコアを含む → 失敗（ハイフンのみ許可）", () => {
      expect(BuildIdSchema.safeParse("build_001").success).toBe(false);
    });

    test("スペースを含む → 失敗", () => {
      expect(BuildIdSchema.safeParse("build 001").success).toBe(false);
    });

    test("スラッシュを含む → 失敗", () => {
      expect(BuildIdSchema.safeParse("build/001").success).toBe(false);
    });

    test("ドットを含む → 失敗", () => {
      expect(BuildIdSchema.safeParse("build.001").success).toBe(false);
    });

    test("日本語を含む → 失敗", () => {
      expect(BuildIdSchema.safeParse("ビルド").success).toBe(false);
    });
  });
});

// ─── StoreHashSchema ─────────────────────────────────────────────────────────

describe("StoreHashSchema", () => {
  describe("有効な値", () => {
    test("小文字英数字のみ（Nix base32）", () => {
      expect(StoreHashSchema.safeParse("aaaa0000bbbb1111").success).toBe(true);
    });

    test("32 文字の Nix store hash 形式", () => {
      // Nix の実際の store hash は 32 文字の lowercase base32
      expect(StoreHashSchema.safeParse("aaaabbbbccccddddeeeeffffgggghhh0").success).toBe(true);
    });

    test("1 文字（最小）", () => {
      expect(StoreHashSchema.safeParse("a").success).toBe(true);
    });

    test("数字のみ", () => {
      expect(StoreHashSchema.safeParse("0123456789").success).toBe(true);
    });
  });

  describe("無効な値", () => {
    test("空文字 → 失敗", () => {
      expect(StoreHashSchema.safeParse("").success).toBe(false);
    });

    test("大文字を含む → 失敗", () => {
      expect(StoreHashSchema.safeParse("AAAA0000").success).toBe(false);
    });

    test("ハイフンを含む → 失敗", () => {
      expect(StoreHashSchema.safeParse("aaaa-0000").success).toBe(false);
    });

    test("スペースを含む → 失敗", () => {
      expect(StoreHashSchema.safeParse("aaaa 0000").success).toBe(false);
    });

    test("スラッシュを含む → 失敗（storeHash はハッシュ部分のみ）", () => {
      expect(StoreHashSchema.safeParse("aaaa/0000").success).toBe(false);
    });

    test("UTF-8 文字を含む → 失敗", () => {
      expect(StoreHashSchema.safeParse("aaaa一").success).toBe(false);
    });

    test("アンダースコアを含む → 失敗", () => {
      expect(StoreHashSchema.safeParse("aaaa_0000").success).toBe(false);
    });
  });
});
