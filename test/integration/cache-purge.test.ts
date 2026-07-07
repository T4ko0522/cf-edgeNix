/**
 * test/integration/cache-purge.test.ts
 *
 * GC execute / publish finalize からの Workers Cache タグ purge 統合テスト。
 * 実ランタイムの ctx.cache.purge は miniflare に無いため、purge を記録する
 * ExecutionContext スタブを apiApp.fetch の第 3 引数として注入して検証する。
 * 非対応環境（ctx.cache なし）では purge がスキップされ処理が成功することも確認する。
 */
import { beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import { apiApp } from "../../src/api/app";
import type { Env } from "../../src/types";

function getEnv() {
  return env as unknown as Env;
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

/** purge 呼び出しを記録する ExecutionContext スタブ */
function makePurgeCtx() {
  const purgedTags: string[][] = [];
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
    cache: {
      purge: async ({ tags }: { tags: string[] }) => {
        purgedTags.push(tags);
        return { success: true };
      },
    },
  } as unknown as ExecutionContext;
  return { ctx, purgedTags, flush: () => Promise.all(pending) };
}

/** purge 非対応の ExecutionContext スタブ（ctx.cache なし） */
function makePlainCtx() {
  return {
    waitUntil: (_p: Promise<unknown>) => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

// ─── D1 フィクスチャ（gc.test.ts と同形式） ─────────────────────────────────

const HOST = "purge-test-host";
const BUILD_ID = "purge-test-build-001";
const HASH = "eeee0000eeee0000ffff1111ffff1111";
const NAR_HASH = "sha256:" + "a".repeat(64);
const FILE_HASH = "sha256:" + "b".repeat(64);
const MANIFEST_HASH = "sha256:" + "c".repeat(64);

const DEAD_HASH = "dddd0000dddd0000dddd0000dddd0000";
const DEAD_NARINFO_KEY = `${DEAD_HASH}.narinfo`;
const DEAD_NAR_FILE = `${"f".repeat(16)}.nar.zst`;
const DEAD_NAR_KEY = `nar/${DEAD_NAR_FILE}`;

async function applyMigrations(db1: D1Database) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS \`build_closure\` (\`build_id\` text NOT NULL, \`store_hash\` text NOT NULL, PRIMARY KEY(\`build_id\`, \`store_hash\`))`,
    `CREATE TABLE IF NOT EXISTS \`build_manifests\` (\`build_id\` text PRIMARY KEY NOT NULL, \`host\` text NOT NULL, \`system\` text NOT NULL, \`git_rev\` text NOT NULL, \`flake_lock_hash\` text NOT NULL, \`toplevel_store_path\` text NOT NULL, \`closure_json_key\` text NOT NULL, \`manifest_key\` text NOT NULL, \`manifest_hash\` text NOT NULL, \`created_at\` integer NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS \`builds\` (\`id\` text PRIMARY KEY NOT NULL, \`host\` text NOT NULL, \`system\` text NOT NULL, \`git_rev\` text NOT NULL, \`flake_lock_hash\` text NOT NULL, \`toplevel_store_path\` text NOT NULL, \`status\` text DEFAULT 'staging' NOT NULL, \`retention_class\` text, \`created_at\` integer NOT NULL, \`published_at\` integer)`,
    `CREATE TABLE IF NOT EXISTS \`nar_files\` (\`file_hash\` text PRIMARY KEY NOT NULL, \`nar_key\` text NOT NULL, \`file_size\` integer NOT NULL, \`compression\` text NOT NULL, \`created_at\` integer NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS \`pinned_builds\` (\`build_id\` text PRIMARY KEY NOT NULL, \`pinned_at\` integer NOT NULL, \`reason\` text)`,
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
    "pinned_builds",
    "rollback_roots",
    "store_paths",
    "builds",
  ]) {
    await db1.prepare(`DELETE FROM ${table}`).run();
  }
}

const startBody = {
  build: {
    id: BUILD_ID,
    host: HOST,
    system: "x86_64-linux",
    gitRev: "cafebabe",
    flakeLockHash: "sha256:purgelock",
    toplevelStorePath: `/nix/store/${HASH}-pkg`,
    createdAt: 1700000100000,
  },
};

const ingestBody = {
  storePaths: [
    {
      storeHash: HASH,
      storePath: `/nix/store/${HASH}-pkg`,
      narinfoKey: `${HASH}.narinfo`,
      narKey: `nar/${HASH}.nar.zst`,
      narHash: NAR_HASH,
      narSize: 1500,
      fileHash: FILE_HASH,
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
    flakeLockHash: "sha256:purgelock",
    toplevelStorePath: `/nix/store/${HASH}-pkg`,
    closureJsonKey: `manifests/${BUILD_ID}/closure.json`,
    manifestKey: `manifests/${BUILD_ID}/manifest.json`,
    manifestHash: MANIFEST_HASH,
  },
};

/** GC 対象の dead store path を D1 / KV / R2 に配置する */
async function insertDeadStorePath(db1: D1Database) {
  await db1.prepare(
    `INSERT INTO store_paths (store_hash, store_path, narinfo_key, nar_key, nar_hash, nar_size, file_hash, file_size, compression, created_at)
     VALUES (?, ?, ?, ?, ?, 100, ?, 50, 'zstd', 1700000000000)`,
  ).bind(
    DEAD_HASH,
    `/nix/store/${DEAD_HASH}-dead`,
    DEAD_NARINFO_KEY,
    DEAD_NAR_KEY,
    "sha256:" + "d".repeat(64),
    "sha256:" + "e".repeat(64),
  ).run();
  await db1.prepare(
    `INSERT INTO nar_files (file_hash, nar_key, file_size, compression, created_at)
     VALUES (?, ?, 50, 'zstd', 1700000000000)`,
  ).bind("sha256:" + "e".repeat(64), DEAD_NAR_KEY).run();
}

async function putDeadObjects(eenv: Env) {
  await eenv.META_KV.put(`narinfo:${DEAD_HASH}`, "StorePath: dead\n");
  await eenv.NAR_BUCKET.put(DEAD_NARINFO_KEY, "StorePath: dead\n");
  await eenv.NAR_BUCKET.put(DEAD_NAR_KEY, "dead nar bytes");
}

beforeEach(async () => {
  const db1 = getEnv().CONTROL_DB;
  await applyMigrations(db1);
  await cleanupTables(db1);
});

// ─── GC execute の purge ─────────────────────────────────────────────────────

describe("GC execute の edge purge", () => {
  test("phase=narinfo: narinfo:<storeHash> タグを purge し edge_purge_attempted を返す", async () => {
    const eenv = authedEnv();
    await insertDeadStorePath(eenv.CONTROL_DB);
    await putDeadObjects(eenv);
    const { ctx, purgedTags, flush } = makePurgeCtx();

    const res = await apiApp.fetch(
      makeWriteReq("/api/gc/execute", { phase: "narinfo" }),
      eenv,
      ctx,
    );
    await flush();

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["edge_purge_attempted"]).toBe(1);
    expect(purgedTags.flat()).toContain(`narinfo:${DEAD_HASH}`);
  });

  test("phase=nar: nar:<fileName> タグを purge する", async () => {
    const eenv = authedEnv();
    await insertDeadStorePath(eenv.CONTROL_DB);
    await putDeadObjects(eenv);
    const { ctx, purgedTags, flush } = makePurgeCtx();

    const res = await apiApp.fetch(
      makeWriteReq("/api/gc/execute", { phase: "nar" }),
      eenv,
      ctx,
    );
    await flush();

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["edge_purge_attempted"]).toBe(1);
    expect(purgedTags.flat()).toContain(`nar:${DEAD_NAR_FILE}`);
  });

  test("purge 非対応ランタイム（ctx.cache なし）でも GC は成功し edge_purge_attempted は 0", async () => {
    const eenv = authedEnv();
    await insertDeadStorePath(eenv.CONTROL_DB);
    await putDeadObjects(eenv);

    const res = await apiApp.fetch(
      makeWriteReq("/api/gc/execute", { phase: "all" }),
      eenv,
      makePlainCtx(),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["edge_purge_attempted"]).toBe(0);
    // 実削除は完了している
    expect(await eenv.META_KV.get(`narinfo:${DEAD_HASH}`, "text")).toBeNull();
    expect(await eenv.NAR_BUCKET.get(DEAD_NARINFO_KEY)).toBeNull();
  });

  test("dry_run では purge しない", async () => {
    const eenv = authedEnv();
    await insertDeadStorePath(eenv.CONTROL_DB);
    await putDeadObjects(eenv);
    const { ctx, purgedTags, flush } = makePurgeCtx();

    const res = await apiApp.fetch(
      makeWriteReq("/api/gc/execute", { phase: "all", dry_run: true }),
      eenv,
      ctx,
    );
    await flush();

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["edge_purge_attempted"]).toBe(0);
    expect(purgedTags).toEqual([]);
  });
});

// ─── publish finalize の purge（negative cache 即時解消） ─────────────────────

describe("publish finalize の edge purge", () => {
  test("finalize 成功後に closure の narinfo:<storeHash> タグを purge する", async () => {
    const eenv = authedEnv();
    const { ctx, purgedTags, flush } = makePurgeCtx();

    await apiApp.fetch(makeWriteReq("/api/publish/start", startBody), eenv, ctx);
    await apiApp.fetch(makeWriteReq(`/api/publish/${BUILD_ID}/ingest`, ingestBody), eenv, ctx);
    const res = await apiApp.fetch(
      makeWriteReq(`/api/publish/${BUILD_ID}/finalize`, finalizeBody),
      eenv,
      ctx,
    );
    await flush();

    expect(res.status).toBe(200);
    expect(purgedTags.flat()).toContain(`narinfo:${HASH}`);
  });

  test("purge 非対応ランタイムでも finalize は成功する", async () => {
    const eenv = authedEnv();
    const ctx = makePlainCtx();

    await apiApp.fetch(makeWriteReq("/api/publish/start", startBody), eenv, ctx);
    await apiApp.fetch(makeWriteReq(`/api/publish/${BUILD_ID}/ingest`, ingestBody), eenv, ctx);
    const res = await apiApp.fetch(
      makeWriteReq(`/api/publish/${BUILD_ID}/finalize`, finalizeBody),
      eenv,
      ctx,
    );

    expect(res.status).toBe(200);
  });
});
