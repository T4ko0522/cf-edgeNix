/**
 * test/auth.test.ts
 *
 * `checkAdminAuth` / `validateHost` / `validateBuildId` / `validateStoreHash` の単体テスト。
 * 受入条件: B1（write + Bearer）/ B3（未設定 403）/ B4（入力検証形式）
 */
import { describe, expect, test } from "vitest";
import {
  checkAdminAuth,
  validateBuildId,
  validateHost,
  validateStoreHash,
} from "../src/auth";

// ─── checkAdminAuth ──────────────────────────────────────────────────────────

describe("checkAdminAuth", () => {
  // adminToken 未設定（undefined / 空文字）→ 403
  test("adminToken が undefined → { ok:false, status:403 }", () => {
    const req = new Request("https://example.com/", { method: "POST" });
    expect(checkAdminAuth(req, undefined)).toEqual({ ok: false, status: 403 });
  });

  test("adminToken が空文字 → { ok:false, status:403 }", () => {
    const req = new Request("https://example.com/", { method: "POST" });
    expect(checkAdminAuth(req, "")).toEqual({ ok: false, status: 403 });
  });

  // Authorization ヘッダ欠落 → 401
  test("Authorization ヘッダなし → { ok:false, status:401 }", () => {
    const req = new Request("https://example.com/", { method: "POST" });
    expect(checkAdminAuth(req, "secret")).toEqual({ ok: false, status: 401 });
  });

  // Bearer プレフィクス不正 → 401
  test("Basic 形式の Authorization → { ok:false, status:401 }", () => {
    const req = new Request("https://example.com/", {
      method: "POST",
      headers: { Authorization: "Basic secret" },
    });
    expect(checkAdminAuth(req, "secret")).toEqual({ ok: false, status: 401 });
  });

  test("Bearer プレフィクスなし → { ok:false, status:401 }", () => {
    const req = new Request("https://example.com/", {
      method: "POST",
      headers: { Authorization: "secret" },
    });
    expect(checkAdminAuth(req, "secret")).toEqual({ ok: false, status: 401 });
  });

  // トークン不一致 → 401
  test("Bearer 形式だがトークン不一致 → { ok:false, status:401 }", () => {
    const req = new Request("https://example.com/", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(checkAdminAuth(req, "secret")).toEqual({ ok: false, status: 401 });
  });

  // 一致 → { ok:true }
  test("トークン一致 → { ok:true }", () => {
    const req = new Request("https://example.com/", {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
    });
    expect(checkAdminAuth(req, "secret")).toEqual({ ok: true });
  });

  // 長めのトークンでも正しく一致する
  test("長いトークンが一致する → { ok:true }", () => {
    const token = "a".repeat(64);
    const req = new Request("https://example.com/", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(checkAdminAuth(req, token)).toEqual({ ok: true });
  });

  // 定数時間比較: prefix 一致だが末尾が異なる → 401
  test("トークンが先頭一致するが末尾が異なる → { ok:false, status:401 }", () => {
    const req = new Request("https://example.com/", {
      method: "POST",
      headers: { Authorization: "Bearer secretX" },
    });
    expect(checkAdminAuth(req, "secret")).toEqual({ ok: false, status: 401 });
  });

  // 空トークンを渡した場合（adminToken は "" 以外・ここでは Bearer に空値）
  test("Bearer が空文字 → { ok:false, status:401 }", () => {
    const req = new Request("https://example.com/", {
      method: "POST",
      headers: { Authorization: "Bearer " },
    });
    expect(checkAdminAuth(req, "secret")).toEqual({ ok: false, status: 401 });
  });
});

// ─── validateHost ────────────────────────────────────────────────────────────

describe("validateHost", () => {
  test("英数字とドット・ハイフン → true", () => {
    expect(validateHost("my-host.example.com")).toBe(true);
  });

  test("英数字のみ → true", () => {
    expect(validateHost("myhost")).toBe(true);
  });

  test("アンダースコア含む → true", () => {
    expect(validateHost("my_host")).toBe(true);
  });

  test("スペース含む → false", () => {
    expect(validateHost("host with space")).toBe(false);
  });

  test("スラッシュ含む → false", () => {
    expect(validateHost("host/name")).toBe(false);
  });

  test("空文字 → false", () => {
    expect(validateHost("")).toBe(false);
  });

  test("日本語文字 → false", () => {
    expect(validateHost("ホスト")).toBe(false);
  });

  test("@記号 → false", () => {
    expect(validateHost("host@example.com")).toBe(false);
  });
});

// ─── validateBuildId ─────────────────────────────────────────────────────────

describe("validateBuildId", () => {
  test("英数字とハイフン → true", () => {
    expect(validateBuildId("abc-123")).toBe(true);
  });

  test("UUID 形式 → true", () => {
    expect(validateBuildId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  test("英数字のみ → true", () => {
    expect(validateBuildId("abc123")).toBe(true);
  });

  test("スペース含む → false", () => {
    expect(validateBuildId("abc 123")).toBe(false);
  });

  test("スラッシュ含む → false", () => {
    expect(validateBuildId("abc/123")).toBe(false);
  });

  test("空文字 → false", () => {
    expect(validateBuildId("")).toBe(false);
  });

  test("アンダースコア → false（ハイフンのみ許可）", () => {
    // 仕様: UUID or [a-zA-Z0-9-]。アンダースコアは含まない。
    expect(validateBuildId("abc_123")).toBe(false);
  });
});

// ─── validateStoreHash ───────────────────────────────────────────────────────

describe("validateStoreHash", () => {
  test("小文字英数字 → true", () => {
    expect(validateStoreHash("abc123def456")).toBe(true);
  });

  test("小文字 base32 文字のみ → true", () => {
    // Nix の store hash は base32 lowercase
    expect(validateStoreHash("0abcdefghijklmnopqrstuvwxyz")).toBe(true);
  });

  test("大文字を含む → false", () => {
    expect(validateStoreHash("ABC")).toBe(false);
  });

  test("ハイフン含む → false", () => {
    expect(validateStoreHash("abc-123")).toBe(false);
  });

  test("空文字 → false", () => {
    expect(validateStoreHash("")).toBe(false);
  });

  test("スペース含む → false", () => {
    expect(validateStoreHash("abc 123")).toBe(false);
  });
});
