/**
 * test/integration/api-read.test.ts
 *
 * read API（GET /api/hosts/:host/latest, builds, manifest.json）の統合テスト。
 * 実 D1 を使い、200/404 を確認する。
 *
 * 受入条件: B2（read 認証不要）/ E4（read クエリ）
 */
import { beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { apiApp } from "../../src/api/app";
import * as schema from "../../src/db/schema";
import type { Env } from "../../src/types";

// ─── ヘルパ ─────────────────────────────────────────────────────────────────

function getDb() {
  return drizzle((env as unknown as Env).CONTROL_DB, { schema });
}

function authedEnv() {
  return { ...(env as object), ADMIN_TOKEN: "test-admin-token" } as unknown as Env;
}

function makeWriteReq(path: string, body: unknown) {
  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-admin-token",
    },
    body: JSON.stringify(body),
  });
}

function makeReadReq(path: string) {
  return new Request(`https://example.com${path}`, { method: "GET" });
}

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

// ─── フィクスチャ ─────────────────────────────────────────────────────────────

const HOST = "read-test-host";
const BUILD_ID = "read-test-build-001";

// フィクスチャ: 修正11の制約に合わせた実形式
const READ_HASH = "cccc0000cccc0000dddd1111dddd1111";
const READ_NAR_HASH = "sha256:" + "a".repeat(64);
const READ_FILE_HASH = "sha256:" + "b".repeat(64);
const READ_MANIFEST_HASH = "sha256:" + "c".repeat(64);

const startBody = {
  build: {
    id: BUILD_ID,
    host: HOST,
    system: "x86_64-linux",
    gitRev: "cafebabe",
    flakeLockHash: "sha256:readlock",
    toplevelStorePath: `/nix/store/${READ_HASH}-pkg`,
    createdAt: 1700000100000,
  },
};

const ingestBody = {
  storePaths: [
    {
      storeHash: READ_HASH,
      storePath: `/nix/store/${READ_HASH}-pkg`,
      narinfoKey: `${READ_HASH}.narinfo`,
      narKey: `nar/${READ_HASH}.nar.zst`,
      narHash: READ_NAR_HASH,
      narSize: 1500,
      fileHash: READ_FILE_HASH,
      fileSize: 700,
      compression: "zstd",
    },
  ],
};

const finalizeBody = {
  manifest: {
    host: HOST,
    system: "x86_64-linux",
    gitRev: "cafebabe",
    flakeLockHash: "sha256:readlock",
    toplevelStorePath: `/nix/store/${READ_HASH}-pkg`,
    closureJsonKey: "manifests/read-test-build-001/closure.json",
    manifestKey: "manifests/read-test-build-001/manifest.json",
    manifestHash: READ_MANIFEST_HASH,
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

// ─── beforeEach ──────────────────────────────────────────────────────────────

beforeEach(async () => {
  const db1 = (env as unknown as Env).CONTROL_DB;
  await applyMigrations(db1);
  await cleanupTables(db1);
});

// ─── helper: published build を作る ──────────────────────────────────────────

async function publishBuild() {
  const eenv = authedEnv();
  await apiApp.fetch(makeWriteReq("/api/publish/start", startBody), eenv);
  await apiApp.fetch(makeWriteReq(`/api/publish/${BUILD_ID}/ingest`, ingestBody), eenv);
  await apiApp.fetch(makeWriteReq(`/api/publish/${BUILD_ID}/finalize`, finalizeBody), eenv);
}

// ─── GET /api/hosts/:host/latest ─────────────────────────────────────────────

describe("GET /api/hosts/:host/latest", () => {
  test("published build が存在する場合 200 を返す", async () => {
    await publishBuild();

    const res = await apiApp.fetch(
      makeReadReq(`/api/hosts/${HOST}/latest`),
      authedEnv(),
    );
    expect(res.status).toBe(200);
  });

  test("published build が存在する場合: レスポンスに id が含まれる", async () => {
    await publishBuild();

    const res = await apiApp.fetch(
      makeReadReq(`/api/hosts/${HOST}/latest`),
      authedEnv(),
    );
    const body = await res.json() as Record<string, unknown>;
    expect(body["id"]).toBe(BUILD_ID);
  });

  test("published build が存在する場合: status が 'published'", async () => {
    await publishBuild();

    const res = await apiApp.fetch(
      makeReadReq(`/api/hosts/${HOST}/latest`),
      authedEnv(),
    );
    const body = await res.json() as Record<string, unknown>;
    expect(body["status"]).toBe("published");
  });

  test("build が存在しない場合 404 を返す", async () => {
    const res = await apiApp.fetch(
      makeReadReq("/api/hosts/nonexistent-host/latest"),
      authedEnv(),
    );
    expect(res.status).toBe(404);
  });

  test("staging のみ存在する場合 404 を返す（G1）", async () => {
    // start のみ（finalize しない）
    await apiApp.fetch(
      makeWriteReq("/api/publish/start", startBody),
      authedEnv(),
    );

    const res = await apiApp.fetch(
      makeReadReq(`/api/hosts/${HOST}/latest`),
      authedEnv(),
    );
    expect(res.status).toBe(404);
  });

  test("認証なしでもアクセスできる（B2）", async () => {
    await publishBuild();

    const res = await apiApp.fetch(
      makeReadReq(`/api/hosts/${HOST}/latest`),
      env as unknown as Env, // ADMIN_TOKEN なし
    );
    // 200 または 404（認証不要＝401/403 でないことが要件）
    expect([200, 404]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ─── GET /api/hosts/:host/builds ─────────────────────────────────────────────

describe("GET /api/hosts/:host/builds", () => {
  test("published build が存在する場合 200 を返す", async () => {
    await publishBuild();

    const res = await apiApp.fetch(
      makeReadReq(`/api/hosts/${HOST}/builds`),
      authedEnv(),
    );
    expect(res.status).toBe(200);
  });

  test("レスポンスに host と builds 配列が含まれる", async () => {
    await publishBuild();

    const res = await apiApp.fetch(
      makeReadReq(`/api/hosts/${HOST}/builds`),
      authedEnv(),
    );
    const body = await res.json() as Record<string, unknown>;
    expect(body["host"]).toBe(HOST);
    expect(Array.isArray(body["builds"])).toBe(true);
    expect((body["builds"] as unknown[]).length).toBeGreaterThan(0);
  });

  test("build が存在しない場合でも 200 と空配列を返す", async () => {
    const res = await apiApp.fetch(
      makeReadReq("/api/hosts/empty-host/builds"),
      authedEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Array.isArray(body["builds"])).toBe(true);
    expect((body["builds"] as unknown[]).length).toBe(0);
  });

  test("認証なしでもアクセスできる（B2）", async () => {
    const res = await apiApp.fetch(
      makeReadReq(`/api/hosts/${HOST}/builds`),
      env as unknown as Env,
    );
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ─── GET /api/builds/:buildId/manifest.json ──────────────────────────────────

describe("GET /api/builds/:buildId/manifest.json", () => {
  test("manifest が存在する場合 200 を返す", async () => {
    await publishBuild();

    const res = await apiApp.fetch(
      makeReadReq(`/api/builds/${BUILD_ID}/manifest.json`),
      authedEnv(),
    );
    expect(res.status).toBe(200);
  });

  test("manifest が存在する場合: レスポンスに buildId が含まれる", async () => {
    await publishBuild();

    const res = await apiApp.fetch(
      makeReadReq(`/api/builds/${BUILD_ID}/manifest.json`),
      authedEnv(),
    );
    const body = await res.json() as Record<string, unknown>;
    expect(body["buildId"]).toBe(BUILD_ID);
  });

  test("manifest が存在する場合: manifestHash が正しい", async () => {
    await publishBuild();

    const res = await apiApp.fetch(
      makeReadReq(`/api/builds/${BUILD_ID}/manifest.json`),
      authedEnv(),
    );
    const body = await res.json() as Record<string, unknown>;
    expect(body["manifestHash"]).toBe(finalizeBody.manifest.manifestHash);
  });

  test("build が存在しない場合 404 を返す", async () => {
    const res = await apiApp.fetch(
      makeReadReq("/api/builds/nonexistent-build/manifest.json"),
      authedEnv(),
    );
    expect(res.status).toBe(404);
  });

  test("認証なしでもアクセスできる（B2）", async () => {
    await publishBuild();

    const res = await apiApp.fetch(
      makeReadReq(`/api/builds/${BUILD_ID}/manifest.json`),
      env as unknown as Env,
    );
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
