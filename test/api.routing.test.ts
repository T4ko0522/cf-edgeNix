/**
 * test/api.routing.test.ts
 *
 * hono `apiApp` の認証・入力検証の単体テスト（旧 handleApi 経路を廃止）。
 * 受入条件: B1（write は認証必須）/ B2（read GET は認証不要）/ B4（不正入力 400）
 *
 * D1 依存する実 DB クエリには到達しないよう、認証 / 入力検証レイヤーのみを検証する。
 * - write 系: 認証なし → 401/403
 * - write 系: 入力不正 → 400 （認証は通過、D1 は呼ばれない）
 * - read 系: 認証なし → 200 / 404（認証は通過するが D1 はモックなので 500 もあり得る）
 *
 * 注: read 系 GET に対し 401/403 が返る場合は認証が誤って挟まっているバグを示す。
 */
import { describe, expect, test } from "vitest";
import { apiApp } from "../src/api/app";

// ─── テスト用 Env ─────────────────────────────────────────────────────────────

/** 最小限の偽 D1Database（Drizzle の型チェックを通す程度） */
function makeFakeD1(): D1Database {
  return {
    prepare: () => { throw new Error("fake D1"); },
    batch: () => Promise.resolve([]),
    exec: () => Promise.resolve({
      results: [], success: true,
      meta: {
        last_row_id: 0, changes: 0, served_by: "", served_by_region: "",
        served_by_primary: true, timings: { sql_duration_ms: 0 },
        changed_db: false, size_after: 0, rows_read: 0, rows_written: 0, duration: 0,
      },
    }),
    dump: () => Promise.resolve(new ArrayBuffer(0)),
  } as unknown as D1Database;
}

function makeEnv(opts?: { adminToken?: string }) {
  return {
    NAR_BUCKET: {} as R2Bucket,
    META_KV: {} as KVNamespace,
    CONTROL_DB: makeFakeD1(),
    ADMIN_TOKEN: opts?.adminToken,
    CACHE_INFO_PRIORITY: "r2",
  };
}

// ─── write 系: 認証ガード ─────────────────────────────────────────────────────

describe("write 系 - ADMIN_TOKEN 未設定 → 403", () => {
  test("POST /api/publish/start: ADMIN_TOKEN 未設定 → 403", async () => {
    const env = makeEnv();
    const req = new Request("https://example.com/api/publish/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ build: {} }),
    });
    const res = await apiApp.fetch(req, env);
    expect(res.status).toBe(403);
  });

  test("POST /api/gc/dry-run: ADMIN_TOKEN 未設定 → 403", async () => {
    const env = makeEnv();
    const req = new Request("https://example.com/api/gc/dry-run", {
      method: "POST",
    });
    const res = await apiApp.fetch(req, env);
    expect(res.status).toBe(403);
  });

  test("POST /api/hosts/myhost/rollback: ADMIN_TOKEN 未設定 → 403", async () => {
    const env = makeEnv();
    const req = new Request("https://example.com/api/hosts/myhost/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await apiApp.fetch(req, env);
    expect(res.status).toBe(403);
  });
});

describe("write 系 - Authorization なし → 401", () => {
  test("POST /api/publish/start: Authorization なし → 401", async () => {
    const env = makeEnv({ adminToken: "secret" });
    const req = new Request("https://example.com/api/publish/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ build: {} }),
    });
    const res = await apiApp.fetch(req, env);
    expect(res.status).toBe(401);
  });

  test("POST /api/publish/start: トークン不一致 → 401", async () => {
    const env = makeEnv({ adminToken: "correct" });
    const req = new Request("https://example.com/api/publish/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong",
      },
      body: JSON.stringify({ build: {} }),
    });
    const res = await apiApp.fetch(req, env);
    expect(res.status).toBe(401);
  });

  test("POST /api/hosts/myhost/rollback: Authorization なし → 401", async () => {
    const env = makeEnv({ adminToken: "secret" });
    const req = new Request("https://example.com/api/hosts/myhost/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await apiApp.fetch(req, env);
    expect(res.status).toBe(401);
  });
});

describe("write 系 - 入力検証（認証通過後）", () => {
  function authHeader(token = "secret") {
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  test("POST /api/publish/start: 空 body → 400", async () => {
    const env = makeEnv({ adminToken: "secret" });
    const req = new Request("https://example.com/api/publish/start", {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({}),
    });
    const res = await apiApp.fetch(req, env);
    expect(res.status).toBe(400);
  });

  test("POST /api/publish/start: build.host に @ → 400", async () => {
    const env = makeEnv({ adminToken: "secret" });
    const req = new Request("https://example.com/api/publish/start", {
      method: "POST",
      headers: authHeader(),
      body: JSON.stringify({
        build: {
          id: "build-001",
          host: "host@invalid",
          system: "x86_64-linux",
          gitRev: "abc",
          flakeLockHash: "sha256:abc",
          toplevelStorePath: "/nix/store/abc-pkg",
          createdAt: 1700000000000,
        },
      }),
    });
    const res = await apiApp.fetch(req, env);
    expect(res.status).toBe(400);
  });
});

// ─── read 系: 認証不要（401/403 を返さない） ─────────────────────────────────

describe("read 系 GET - 認証不要（401/403 を返さない）", () => {
  test("GET /api/hosts/test-host/latest: 401/403 を返さない", async () => {
    const env = makeEnv(); // ADMIN_TOKEN なし
    const req = new Request("https://example.com/api/hosts/test-host/latest");
    const res = await apiApp.fetch(req, env);
    // D1 が fake なのでクエリは失敗するが、認証で弾かれてはいけない
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  test("GET /api/hosts/test-host/builds: 401/403 を返さない", async () => {
    const env = makeEnv();
    const req = new Request("https://example.com/api/hosts/test-host/builds");
    const res = await apiApp.fetch(req, env);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  test("GET /api/builds/build-001/manifest.json: 401/403 を返さない", async () => {
    const env = makeEnv();
    const req = new Request("https://example.com/api/builds/build-001/manifest.json");
    const res = await apiApp.fetch(req, env);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
