/**
 * test/integration/auth.test.ts
 *
 * 認証ミドルウェアの統合テスト（hono 経由）。
 * write 系が ADMIN_TOKEN 無しで 401/403、read 系は認証不要で 200/404 を確認。
 * zod による不正 host パラメータが 400 になることも確認する。
 *
 * 受入条件: B1/B2/B3/B4
 */
import { beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import { apiApp } from "../../src/api/app";
import type { Env } from "../../src/types";

// ─── ヘルパ ─────────────────────────────────────────────────────────────────

async function applyMigrations(db1: D1Database) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS \`build_closure\` (\`build_id\` text NOT NULL, \`store_hash\` text NOT NULL, PRIMARY KEY(\`build_id\`, \`store_hash\`))`,
    `CREATE INDEX IF NOT EXISTS \`idx_build_closure_store\` ON \`build_closure\` (\`store_hash\`)`,
    `CREATE TABLE IF NOT EXISTS \`build_manifests\` (\`build_id\` text PRIMARY KEY NOT NULL, \`host\` text NOT NULL, \`system\` text NOT NULL, \`git_rev\` text NOT NULL, \`flake_lock_hash\` text NOT NULL, \`toplevel_store_path\` text NOT NULL, \`closure_json_key\` text NOT NULL, \`manifest_key\` text NOT NULL, \`manifest_hash\` text NOT NULL, \`created_at\` integer NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS \`idx_build_manifests_host\` ON \`build_manifests\` (\`host\`, \`created_at\`)`,
    `CREATE TABLE IF NOT EXISTS \`builds\` (\`id\` text PRIMARY KEY NOT NULL, \`host\` text NOT NULL, \`system\` text NOT NULL, \`git_rev\` text NOT NULL, \`flake_lock_hash\` text NOT NULL, \`toplevel_store_path\` text NOT NULL, \`status\` text DEFAULT 'staging' NOT NULL, \`retention_class\` text, \`created_at\` integer NOT NULL, \`published_at\` integer)`,
    `CREATE INDEX IF NOT EXISTS \`idx_builds_host_published\` ON \`builds\` (\`host\`, \`published_at\`)`,
    `CREATE TABLE IF NOT EXISTS \`nar_files\` (\`file_hash\` text PRIMARY KEY NOT NULL, \`nar_key\` text NOT NULL, \`file_size\` integer NOT NULL, \`compression\` text NOT NULL, \`created_at\` integer NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS \`rollback_roots\` (\`id\` text PRIMARY KEY NOT NULL, \`host\` text NOT NULL, \`build_id\` text NOT NULL, \`reason\` text, \`pinned\` integer DEFAULT 0 NOT NULL, \`keep_until\` integer, \`created_at\` integer NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS \`store_paths\` (\`store_hash\` text PRIMARY KEY NOT NULL, \`store_path\` text NOT NULL, \`narinfo_key\` text NOT NULL, \`nar_key\` text NOT NULL, \`nar_hash\` text NOT NULL, \`nar_size\` integer NOT NULL, \`file_hash\` text NOT NULL, \`file_size\` integer NOT NULL, \`compression\` text NOT NULL, \`first_seen_build_id\` text, \`created_at\` integer NOT NULL)`,
  ];
  for (const stmt of stmts) {
    await db1.prepare(stmt).run();
  }
}

function makeReq(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    token?: string | null;
    noAuth?: boolean;
  } = {},
) {
  const { method = "POST", body, token, noAuth = false } = opts;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (!noAuth && token !== null) {
    const t = token ?? "test-token";
    headers["authorization"] = `Bearer ${t}`;
  }
  return new Request(`https://example.com${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** ADMIN_TOKEN 未設定の env */
function noTokenEnv() {
  const e = { ...(env as object) } as Record<string, unknown>;
  delete e["ADMIN_TOKEN"];
  return e as unknown as Env;
}

/** ADMIN_TOKEN が設定された env */
function authedEnv(token = "test-admin-token") {
  return { ...(env as object), ADMIN_TOKEN: token } as unknown as Env;
}

const validStartBody = {
  build: {
    id: "auth-test-build",
    host: "auth-test-host",
    system: "x86_64-linux",
    gitRev: "abc",
    flakeLockHash: "sha256:lock",
    toplevelStorePath: "/nix/store/aaaa0000-pkg",
    createdAt: 1700000000000,
  },
};

async function cleanupTables(db1: D1Database) {
  for (const table of [
    "build_closure",
    "build_manifests",
    "nar_files",
    "rollback_roots",
    "store_paths",
    "builds",
  ]) {
    await db1.prepare(`DELETE FROM ${table}`).run();
  }
}

beforeEach(async () => {
  const db1 = (env as unknown as Env).CONTROL_DB;
  await applyMigrations(db1);
  await cleanupTables(db1);
});

// ─── write 系: ADMIN_TOKEN 未設定 → 403 ─────────────────────────────────────

describe("write 系: ADMIN_TOKEN 未設定 → 403（B3）", () => {
  test("POST /api/publish/start: ADMIN_TOKEN 未設定 → 403", async () => {
    const res = await apiApp.fetch(
      makeReq("/api/publish/start", { body: validStartBody }),
      noTokenEnv(),
    );
    expect(res.status).toBe(403);
  });

  test("POST /api/publish/:buildId/ingest: ADMIN_TOKEN 未設定 → 403", async () => {
    const res = await apiApp.fetch(
      makeReq("/api/publish/build-xxx/ingest", {
        body: { storePaths: [] },
      }),
      noTokenEnv(),
    );
    expect(res.status).toBe(403);
  });

  test("POST /api/publish/:buildId/finalize: ADMIN_TOKEN 未設定 → 403", async () => {
    const res = await apiApp.fetch(
      makeReq("/api/publish/build-xxx/finalize", {
        body: {
          manifest: {
            host: "h",
            system: "x86_64-linux",
            gitRev: "a",
            flakeLockHash: "sha256:l",
            toplevelStorePath: "/nix/store/x-p",
            closureJsonKey: "c",
            manifestKey: "m",
            manifestHash: "sha256:h",
          },
        },
      }),
      noTokenEnv(),
    );
    expect(res.status).toBe(403);
  });

  test("POST /api/gc/dry-run: ADMIN_TOKEN 未設定 → 403", async () => {
    const res = await apiApp.fetch(
      makeReq("/api/gc/dry-run", { body: {} }),
      noTokenEnv(),
    );
    expect(res.status).toBe(403);
  });

  test("POST /api/hosts/:host/rollback: ADMIN_TOKEN 未設定 → 403", async () => {
    const res = await apiApp.fetch(
      makeReq("/api/hosts/my-host/rollback", {
        body: { build_id: "build-001" },
      }),
      noTokenEnv(),
    );
    expect(res.status).toBe(403);
  });
});

// ─── write 系: トークン不一致 → 401 ─────────────────────────────────────────

describe("write 系: トークン不一致 → 401（B1）", () => {
  test("POST /api/publish/start: トークン不一致 → 401", async () => {
    const res = await apiApp.fetch(
      makeReq("/api/publish/start", {
        body: validStartBody,
        token: "wrong-token",
      }),
      authedEnv("correct-token"),
    );
    expect(res.status).toBe(401);
  });

  test("POST /api/publish/start: Authorization ヘッダなし → 401", async () => {
    const res = await apiApp.fetch(
      makeReq("/api/publish/start", {
        body: validStartBody,
        noAuth: true,
      }),
      authedEnv(),
    );
    expect(res.status).toBe(401);
  });

  test("POST /api/gc/dry-run: トークン不一致 → 401", async () => {
    const res = await apiApp.fetch(
      makeReq("/api/gc/dry-run", { body: {}, token: "bad" }),
      authedEnv("good-token"),
    );
    expect(res.status).toBe(401);
  });

  test("POST /api/hosts/:host/rollback: Authorization なし → 401", async () => {
    const res = await apiApp.fetch(
      makeReq("/api/hosts/my-host/rollback", {
        body: { build_id: "build-001" },
        noAuth: true,
      }),
      authedEnv(),
    );
    expect(res.status).toBe(401);
  });
});

// ─── read 系: 認証不要（B2） ─────────────────────────────────────────────────

describe("read 系: 認証不要（B2）", () => {
  test("GET /api/hosts/:host/latest: 認証なしで 200 または 404（401/403 でない）", async () => {
    const res = await apiApp.fetch(
      new Request("https://example.com/api/hosts/test-host/latest"),
      noTokenEnv(),
    );
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect([200, 404]).toContain(res.status);
  });

  test("GET /api/hosts/:host/builds: 認証なしで 200（B2）", async () => {
    const res = await apiApp.fetch(
      new Request("https://example.com/api/hosts/test-host/builds"),
      noTokenEnv(),
    );
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });

  test("GET /api/builds/:buildId/manifest.json: 認証なしで 200 または 404（401/403 でない）", async () => {
    const res = await apiApp.fetch(
      new Request("https://example.com/api/builds/some-build/manifest.json"),
      noTokenEnv(),
    );
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect([200, 404]).toContain(res.status);
  });

  test("GET /api/openapi.json: 認証なしで 200", async () => {
    const res = await apiApp.fetch(
      new Request("https://example.com/api/openapi.json"),
      noTokenEnv(),
    );
    expect(res.status).toBe(200);
  });
});

// ─── zod path param 検証（B4） ───────────────────────────────────────────────

describe("zod path params 検証（B4）", () => {
  test("GET /api/hosts/:host/latest: host にスペースを含む場合 400（HostSchema）", async () => {
    // URL エンコードで実際に渡す
    const res = await apiApp.fetch(
      new Request("https://example.com/api/hosts/host%20with%20space/latest"),
      authedEnv(),
    );
    // hono の zod-openapi は path param の validation で 400 を返す
    expect(res.status).toBe(400);
  });

  test("GET /api/hosts/:host/builds: host が空（400 またはルートマッチ失敗）", async () => {
    // hono でスラッシュのみのパラメータは通常 404 になる
    const res = await apiApp.fetch(
      new Request("https://example.com/api/hosts//builds"),
      authedEnv(),
    );
    expect([400, 404]).toContain(res.status);
  });

  test("GET /api/builds/:buildId/manifest.json: buildId にスラッシュを含む場合 404", async () => {
    // URL 構造上ルートにマッチしない
    const res = await apiApp.fetch(
      new Request("https://example.com/api/builds/bad%2Fid/manifest.json"),
      authedEnv(),
    );
    expect([400, 404]).toContain(res.status);
  });

  test("POST /api/publish/:buildId/ingest: buildId にアンダースコアを含む場合 400（BuildIdSchema）", async () => {
    const res = await apiApp.fetch(
      makeReq("/api/publish/bad_id/ingest", {
        body: { storePaths: [] },
        token: "test-admin-token",
      }),
      authedEnv(),
    );
    expect(res.status).toBe(400);
  });
});
