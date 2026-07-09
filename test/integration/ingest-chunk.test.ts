/**
 * test/integration/ingest-chunk.test.ts
 *
 * Round F 新規テスト: ingest の chunk 境界と既存 store_path の build_closure 登録（G7 回帰）。
 *
 * テスト観点:
 *   - 60 件など STORE_CHUNK(25) を跨ぐ store_paths を ingest し、
 *     全行が実際に INSERT され、各 batch が D1 100 statement 上限内で分割されていること。
 *   - 同一 storeHash を build A → build B で ingest した場合、
 *     build B の build_closure 行が存在すること（G7 回帰 / BLOCKER-3 対応）。
 *
 * 受入条件: G6/G7/A3/A5/E1
 *
 * NixOS 環境: steam-run npx vitest run --project integration
 */
import { beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { apiApp } from "../../src/api/app";
import * as schema from "../../src/db/schema";
import type { Env } from "../../src/types";

// ─── ヘルパ ─────────────────────────────────────────────────────────────────

function getDb() {
  return drizzle((env as unknown as Env).CONTROL_DB, { schema });
}

function authedEnv() {
  return { ...(env as object), ADMIN_TOKEN: "chunk-test-token" } as unknown as Env;
}

function makeWriteReq(path: string, body: unknown) {
  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer chunk-test-token",
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

// ─── chunk 境界テスト ────────────────────────────────────────────────────────

/**
 * 疑似ランダムな 32 文字の Nix base32 ハッシュを生成する。
 * base32 は [0-9a-z] のみ（ただし大文字除外）。
 */
function makeHash(seed: number): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let hash = "";
  let n = seed;
  for (let i = 0; i < 32; i++) {
    hash += chars[n % chars.length];
    n = Math.floor(n / chars.length) + (seed * (i + 1)) % 37;
  }
  // 固定長 32 文字になるよう切り詰め/パディング
  return hash.slice(0, 32).padEnd(32, "0");
}

function makeStorePath(idx: number) {
  const hash = makeHash(idx + 100);
  return {
    storeHash: hash,
    storePath: `/nix/store/${hash}-pkg${idx}`,
    narinfoKey: `${hash}.narinfo`,
    narKey: `nar/${hash}.nar.zst`,
    narHash: "sha256:" + String(idx).padStart(64, "0"),
    narSize: 1000 + idx,
    fileHash: "sha256:" + String(idx + 1000).padStart(64, "0"),
    fileSize: 500 + idx,
    compression: "zstd",
  };
}

describe("ingest chunk 境界（STORE_CHUNK=25 を跨ぐ 60 件）", () => {
  const CHUNK_BUILD_ID = "chunk-test-build-001";
  const CHUNK_HOST = "chunk-test-host";
  const CHUNK_TOP_HASH = makeHash(1);

  const chunkStartBody = {
    build: {
      id: CHUNK_BUILD_ID,
      host: CHUNK_HOST,
      system: "x86_64-linux",
      gitRev: "chunkrev",
      flakeLockHash: "sha256:chunklock",
      toplevelStorePath: `/nix/store/${CHUNK_TOP_HASH}-pkg`,
      createdAt: 1700001000000,
    },
  };

  test("60 件の store_paths を ingest: 全行が store_paths テーブルに INSERT される", async () => {
    const eenv = authedEnv();
    const db = getDb();

    // 60 件のストアパスを生成（STORE_CHUNK=25 を 2 回超える）
    const N = 60;
    const paths = Array.from({ length: N }, (_, i) => makeStorePath(i));

    await apiApp.fetch(makeWriteReq("/api/publish/start", chunkStartBody), eenv);

    const ingestRes = await apiApp.fetch(
      makeWriteReq(`/api/publish/${CHUNK_BUILD_ID}/ingest`, { storePaths: paths }),
      eenv,
    );
    expect(ingestRes.status).toBe(200);

    // SELECT で全件が INSERT されたことを確認
    const allRows = await db.select({ storeHash: schema.storePaths.storeHash })
      .from(schema.storePaths);
    expect(allRows.length).toBe(N);

    // 各ハッシュが実際に存在することを確認（境界値: 先頭・24番目・25番目・49番目・59番目）
    for (const boundary of [0, 24, 25, 49, 59]) {
      const expectedHash = paths[boundary]?.storeHash ?? "";
      const row = await db.select()
        .from(schema.storePaths)
        .where(eq(schema.storePaths.storeHash, expectedHash));
      expect(row).toHaveLength(1);
    }
  });

  test("60 件の store_paths を ingest: 全行が build_closure テーブルに INSERT される", async () => {
    const eenv = authedEnv();
    const db = getDb();

    const N = 60;
    const paths = Array.from({ length: N }, (_, i) => makeStorePath(i));

    await apiApp.fetch(makeWriteReq("/api/publish/start", chunkStartBody), eenv);
    await apiApp.fetch(
      makeWriteReq(`/api/publish/${CHUNK_BUILD_ID}/ingest`, { storePaths: paths }),
      eenv,
    );

    // build_closure の全件を SELECT
    const closureRows = await db.select()
      .from(schema.buildClosure)
      .where(eq(schema.buildClosure.buildId, CHUNK_BUILD_ID));

    expect(closureRows).toHaveLength(N);
  });
});

// ─── 既存 store_path を別 build に ingest（G7 回帰: BLOCKER-3）─────────────

describe("既存 store_path を別 build に ingest: build_closure が作られる（G7 回帰）", () => {
  const SHARED_HASH = makeHash(500);
  const BUILD_A_ID = "shared-path-build-A";
  const BUILD_B_ID = "shared-path-build-B";
  const SHARED_HOST = "shared-path-host";

  const sharedStorePath = {
    storeHash: SHARED_HASH,
    storePath: `/nix/store/${SHARED_HASH}-shared`,
    narinfoKey: `${SHARED_HASH}.narinfo`,
    narKey: `nar/${SHARED_HASH}.nar.zst`,
    narHash: "sha256:" + "a".repeat(64),
    narSize: 7000,
    fileHash: "sha256:" + "b".repeat(64),
    fileSize: 3500,
    compression: "zstd",
  };

  test("build A の ingest 後、build B に同一 storeHash を ingest すると build B の build_closure 行が存在する", async () => {
    const eenv = authedEnv();
    const db = getDb();

    // Build A: start + ingest
    const startBodyA = {
      build: {
        id: BUILD_A_ID,
        host: SHARED_HOST,
        system: "x86_64-linux",
        gitRev: "revA",
        flakeLockHash: "sha256:lockA",
        toplevelStorePath: `/nix/store/${SHARED_HASH}-shared`,
        createdAt: 1700002000000,
      },
    };
    const startResA = await apiApp.fetch(makeWriteReq("/api/publish/start", startBodyA), eenv);
    expect(startResA.status).toBe(200);

    const ingestResA = await apiApp.fetch(
      makeWriteReq(`/api/publish/${BUILD_A_ID}/ingest`, { storePaths: [sharedStorePath] }),
      eenv,
    );
    expect(ingestResA.status).toBe(200);

    // Build B: start + ingest（同一 storeHash を再度 ingest）
    const startBodyB = {
      build: {
        id: BUILD_B_ID,
        host: SHARED_HOST,
        system: "x86_64-linux",
        gitRev: "revB",
        flakeLockHash: "sha256:lockB",
        toplevelStorePath: `/nix/store/${SHARED_HASH}-shared`,
        createdAt: 1700003000000,
      },
    };
    const startResB = await apiApp.fetch(makeWriteReq("/api/publish/start", startBodyB), eenv);
    expect(startResB.status).toBe(200);

    const ingestResB = await apiApp.fetch(
      makeWriteReq(`/api/publish/${BUILD_B_ID}/ingest`, { storePaths: [sharedStorePath] }),
      eenv,
    );
    // 同一 payload の再送は 200（冪等）
    expect(ingestResB.status).toBe(200);

    // Build B の build_closure に行が存在する（BLOCKER-3 回帰テスト）
    const closureB = await db.select()
      .from(schema.buildClosure)
      .where(
        and(
          eq(schema.buildClosure.buildId, BUILD_B_ID),
          eq(schema.buildClosure.storeHash, SHARED_HASH),
        ),
      );
    expect(closureB).toHaveLength(1);

    // Build A の build_closure も存在する
    const closureA = await db.select()
      .from(schema.buildClosure)
      .where(
        and(
          eq(schema.buildClosure.buildId, BUILD_A_ID),
          eq(schema.buildClosure.storeHash, SHARED_HASH),
        ),
      );
    expect(closureA).toHaveLength(1);

    // store_paths の行は 1 件のみ（重複なし）
    const spRows = await db.select()
      .from(schema.storePaths)
      .where(eq(schema.storePaths.storeHash, SHARED_HASH));
    expect(spRows).toHaveLength(1);
  });
});

// ─── 差分 payload → 409 と conflictingStoreHash 構造化 body（運用診断用）────

describe("ingest 差分 payload → 409 レスポンスに conflictingStoreHash が入る", () => {
  const HASH = makeHash(700);
  const BUILD_A_ID = "conflict-payload-build-A";
  const BUILD_B_ID = "conflict-payload-build-B";
  const HOST = "conflict-payload-host";

  const basePath = {
    storeHash: HASH,
    storePath: `/nix/store/${HASH}-thing`,
    narinfoKey: `${HASH}.narinfo`,
    narKey: `nar/${HASH}.nar.zst`,
    narHash: "sha256:" + "c".repeat(64),
    narSize: 4096,
    fileHash: "sha256:" + "d".repeat(64),
    fileSize: 2048,
    compression: "zstd",
  };

  test("build B が同一 storeHash で別 payload を送ると 409 + conflictingStoreHash が返る", async () => {
    const eenv = authedEnv();

    // Build A: 正常に ingest
    const startBodyA = {
      build: {
        id: BUILD_A_ID,
        host: HOST,
        system: "x86_64-linux",
        gitRev: "revA",
        flakeLockHash: "sha256:lockA",
        toplevelStorePath: `/nix/store/${HASH}-thing`,
        createdAt: 1700005000000,
      },
    };
    const startResA = await apiApp.fetch(makeWriteReq("/api/publish/start", startBodyA), eenv);
    expect(startResA.status).toBe(200);
    const ingestResA = await apiApp.fetch(
      makeWriteReq(`/api/publish/${BUILD_A_ID}/ingest`, { storePaths: [basePath] }),
      eenv,
    );
    expect(ingestResA.status).toBe(200);

    // Build B: 同一 storeHash / narKey だが narHash / fileHash などが異なる
    const startBodyB = {
      build: {
        id: BUILD_B_ID,
        host: HOST,
        system: "x86_64-linux",
        gitRev: "revB",
        flakeLockHash: "sha256:lockB",
        toplevelStorePath: `/nix/store/${HASH}-thing`,
        createdAt: 1700006000000,
      },
    };
    const startResB = await apiApp.fetch(makeWriteReq("/api/publish/start", startBodyB), eenv);
    expect(startResB.status).toBe(200);

    const conflictingPath = {
      ...basePath,
      narHash: "sha256:" + "e".repeat(64),
      fileHash: "sha256:" + "f".repeat(64),
      fileSize: 9999,
    };
    const ingestResB = await apiApp.fetch(
      makeWriteReq(`/api/publish/${BUILD_B_ID}/ingest`, { storePaths: [conflictingPath] }),
      eenv,
    );
    expect(ingestResB.status).toBe(409);

    const body = (await ingestResB.json()) as {
      error: string;
      conflictingStoreHash?: string;
    };
    expect(body.conflictingStoreHash).toBe(HASH);
    expect(body.error).toContain(HASH);
  });
});
