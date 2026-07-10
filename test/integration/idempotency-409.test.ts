/**
 * test/integration/idempotency-409.test.ts
 *
 * Round F 新規テスト: finalize / startBuild の差分 payload 再送 409、同一再送 200。
 *
 * テスト観点:
 *   - finalize 差分 manifest（manifestHash が異なる）→ 409（G6 回帰）
 *   - finalize 同一 manifest 再送 → 200（冪等）
 *   - startBuild 差分 meta（system が異なる）→ 409（G6 回帰）
 *   - startBuild 同一 meta 再送 → 200（冪等）
 *
 * 受入条件: G6/A5
 */
import { beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import { apiApp } from "../../src/api/app";
import type { Env } from "../../src/types";

// ─── ヘルパ ─────────────────────────────────────────────────────────────────

function authedEnv() {
  return { ...(env as object), ADMIN_TOKEN: "idempotency-test-token" } as unknown as Env;
}

function makeWriteReq(path: string, body: unknown) {
  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer idempotency-test-token",
    },
    body: JSON.stringify(body),
  });
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

// ─── フィクスチャ ─────────────────────────────────────────────────────────────

const BUILD_HOST = "idempotency-test-host";
const HASH = "aaaa0000aaaa0000bbbb1111bbbb1111";
const NAR_HASH = "sha256:" + "a".repeat(64);
const FILE_HASH = "sha256:" + "b".repeat(64);
const MANIFEST_HASH = "sha256:" + "c".repeat(64);
const DIFF_MANIFEST_HASH = "sha256:" + "d".repeat(64);

function makeStartBody(buildId: string, system = "x86_64-linux") {
  return {
    build: {
      id: buildId,
      host: BUILD_HOST,
      system,
      gitRev: "idempotency-rev",
      flakeLockHash: "sha256:idempotencylock",
      toplevelStorePath: `/nix/store/${HASH}-pkg`,
      createdAt: 1700004000000,
    },
  };
}

function makeIngestBody() {
  return {
    storePaths: [{
      storeHash: HASH,
      storePath: `/nix/store/${HASH}-pkg`,
      narinfoKey: `${HASH}.narinfo`,
      narKey: `nar/${HASH}.nar.zst`,
      narHash: NAR_HASH,
      narSize: 8000,
      fileHash: FILE_HASH,
      fileSize: 4000,
      compression: "zstd",
    }],
  };
}

function makeFinalizeBody(manifestHash = MANIFEST_HASH) {
  return {
    manifest: {
      host: BUILD_HOST,
      system: "x86_64-linux",
      gitRev: "idempotency-rev",
      flakeLockHash: "sha256:idempotencylock",
      toplevelStorePath: `/nix/store/${HASH}-pkg`,
      closureJsonKey: "manifests/idempotency-build/closure.json",
      manifestKey: "manifests/idempotency-build/manifest.json",
      manifestHash,
    },
  };
}

// ─── finalize 差分 → 409 / 同一 → 200 ──────────────────────────────────────

describe("finalize 差分 payload 再送（G6 回帰）", () => {
  const BUILD_ID = "idempotency-finalize-001";

  test("finalize 差分 manifest（manifestHash が異なる）→ 409", async () => {
    const eenv = authedEnv();

    // start + ingest + finalize（1 回目）
    await apiApp.fetch(makeWriteReq("/api/publish/start", makeStartBody(BUILD_ID)), eenv);
    await apiApp.fetch(makeWriteReq(`/api/publish/${BUILD_ID}/ingest`, makeIngestBody()), eenv);
    const res1 = await apiApp.fetch(
      makeWriteReq(`/api/publish/${BUILD_ID}/finalize`, makeFinalizeBody(MANIFEST_HASH)),
      eenv,
    );
    expect(res1.status).toBe(200);

    // finalize 2 回目: manifestHash が異なる → 409
    const res2 = await apiApp.fetch(
      makeWriteReq(`/api/publish/${BUILD_ID}/finalize`, makeFinalizeBody(DIFF_MANIFEST_HASH)),
      eenv,
    );
    expect(res2.status).toBe(409);
  });

  test("finalize 同一 manifest 再送 → 200（冪等）", async () => {
    const eenv = authedEnv();

    // start + ingest + finalize（1 回目）
    await apiApp.fetch(makeWriteReq("/api/publish/start", makeStartBody(BUILD_ID)), eenv);
    await apiApp.fetch(makeWriteReq(`/api/publish/${BUILD_ID}/ingest`, makeIngestBody()), eenv);
    const res1 = await apiApp.fetch(
      makeWriteReq(`/api/publish/${BUILD_ID}/finalize`, makeFinalizeBody(MANIFEST_HASH)),
      eenv,
    );
    expect(res1.status).toBe(200);

    // finalize 2 回目: 同一 payload → 200
    const res2 = await apiApp.fetch(
      makeWriteReq(`/api/publish/${BUILD_ID}/finalize`, makeFinalizeBody(MANIFEST_HASH)),
      eenv,
    );
    expect(res2.status).toBe(200);
  });

  test("finalize 差分 409 のレスポンス body に内部スタックが含まれない", async () => {
    const eenv = authedEnv();

    await apiApp.fetch(makeWriteReq("/api/publish/start", makeStartBody(BUILD_ID)), eenv);
    await apiApp.fetch(makeWriteReq(`/api/publish/${BUILD_ID}/ingest`, makeIngestBody()), eenv);
    await apiApp.fetch(
      makeWriteReq(`/api/publish/${BUILD_ID}/finalize`, makeFinalizeBody(MANIFEST_HASH)),
      eenv,
    );

    const res = await apiApp.fetch(
      makeWriteReq(`/api/publish/${BUILD_ID}/finalize`, makeFinalizeBody(DIFF_MANIFEST_HASH)),
      eenv,
    );
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    const errorMsg = body["error"] as string;
    // スタックトレース（"at "）や内部 D1 情報が含まれないこと
    expect(errorMsg).not.toMatch(/at\s+\w+\s*\(/);
    expect(errorMsg).not.toMatch(/D1_/);
    expect(typeof errorMsg).toBe("string");
  });
});

// ─── startBuild 差分 → 409 / 同一 → 200 ────────────────────────────────────

describe("startBuild 差分 payload 再送（G6 回帰）", () => {
  const START_BUILD_ID = "idempotency-start-001";

  test("startBuild 差分 meta（system が異なる）→ 409", async () => {
    const eenv = authedEnv();

    // start 1 回目
    const res1 = await apiApp.fetch(
      makeWriteReq("/api/publish/start", makeStartBody(START_BUILD_ID, "x86_64-linux")),
      eenv,
    );
    expect(res1.status).toBe(200);

    // start 2 回目: system が異なる → 409
    const res2 = await apiApp.fetch(
      makeWriteReq("/api/publish/start", makeStartBody(START_BUILD_ID, "aarch64-linux")),
      eenv,
    );
    expect(res2.status).toBe(409);
  });

  test("startBuild 同一 meta 再送 → 200（冪等）", async () => {
    const eenv = authedEnv();

    // start 1 回目
    const res1 = await apiApp.fetch(
      makeWriteReq("/api/publish/start", makeStartBody(START_BUILD_ID, "x86_64-linux")),
      eenv,
    );
    expect(res1.status).toBe(200);

    // start 2 回目: 同一 payload → 200
    const res2 = await apiApp.fetch(
      makeWriteReq("/api/publish/start", makeStartBody(START_BUILD_ID, "x86_64-linux")),
      eenv,
    );
    expect(res2.status).toBe(200);
  });
});

// ─── API エラー内部露出抑止 ───────────────────────────────────────────────────

describe("API エラーの内部露出抑止", () => {
  test("未知例外でも body に内部 message/スタックが出ない（汎用 500 のみ）", async () => {
    // 存在しない build_id に ingest → BuildNotFoundError(404)。
    // 既知エラーは意味あるメッセージを返してよいが、スタックは出さない。
    const eenv = authedEnv();
    const res = await apiApp.fetch(
      makeWriteReq("/api/publish/nonexistent-build-id/ingest", { storePaths: [] }),
      eenv,
    );
    expect([404, 409]).toContain(res.status);
    const body = await res.json() as Record<string, unknown>;
    const errorMsg = body["error"] as string;
    // スタックトレースパターンが含まれないこと
    expect(errorMsg).not.toMatch(/at\s+\w+\s*\(/);
    // SQLite 内部メッセージが含まれないこと
    expect(errorMsg).not.toMatch(/SQLITE_/);
  });

  test("認証通過後の 500 系エラーでも内部スタックが body に出ない", async () => {
    // fake D1 を使うと prepare() が throw するが、apiApp.fetch がそれを 500 として
    // 汎用メッセージに変換する。unit テストでも確認できる。
    const fakeD1 = {
      prepare: () => { throw new Error("SQLITE_INTERNAL: some internal detail"); },
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

    const envWithFakeD1 = {
      CONTROL_DB: fakeD1,
      ADMIN_TOKEN: "idempotency-test-token",
      NAR_BUCKET: {} as R2Bucket,
      META_KV: {} as KVNamespace,
      CACHE_INFO_PRIORITY: "r2",
    };

    const req = new Request("https://example.com/api/publish/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer idempotency-test-token",
      },
      body: JSON.stringify({
        build: {
          id: "fake-build-001",
          host: "fake-host",
          system: "x86_64-linux",
          gitRev: "abc",
          flakeLockHash: "sha256:abc",
          toplevelStorePath: "/nix/store/aaaa0000aaaa0000bbbb1111bbbb1111-pkg",
          createdAt: 1700000000000,
        },
      }),
    });

    const res = await apiApp.fetch(req, envWithFakeD1 as unknown as Env);
    // 500 が返ることを期待
    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    const errorMsg = String(body["error"] ?? "");
    // 内部 SQLITE エラー詳細が露出しない
    expect(errorMsg).not.toContain("SQLITE_INTERNAL");
    expect(errorMsg).not.toMatch(/at\s+\w+\s*\(/);
    // 汎用メッセージのみ
    expect(errorMsg).toBe("internal server error");
  });
});
