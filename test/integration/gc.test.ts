/**
 * test/integration/gc.test.ts
 *
 * computeLiveSet の統合テスト（G8）。
 * rollback_roots + published build の closure が live に含まれ、
 * 到達不能 NAR が dead 候補になることを確認する。
 *
 * 受入条件: G8 / POST /api/gc/dry-run
 *
 * NixOS 環境: steam-run npx vitest run --project integration
 */
import { beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import { apiApp } from "../../src/api/app";
import { handleNarinfo } from "../../src/handlers/narinfo";
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

function authedEnv() {
  return { ...(env as object), ADMIN_TOKEN: "gc-test-token" } as unknown as Env;
}

function makeWriteReq(path: string, body: unknown) {
  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer gc-test-token",
    },
    body: JSON.stringify(body),
  });
}

// ─── フィクスチャ ─────────────────────────────────────────────────────────────

const HOST = "gc-test-host";
const BUILD_ID = "gc-test-build-001";

// フィクスチャ: 実形式（Nix base32 小文字英数字）
const GC_HASH = "0000000000000000aaaa1111bbbb2222";
const GC_NAR_HASH = "sha256:" + "a".repeat(64);
const GC_FILE_HASH = "sha256:" + "b".repeat(64);
const GC_MANIFEST_HASH = "sha256:" + "c".repeat(64);

const liveNarKey = `nar/${GC_HASH}.nar.zst`;
// dead: store_paths に存在するが live build の closure に含まれない NAR
const deadHash = "dddd4444dddd4444eeee5555eeee5555";
const deadNarKey = `nar/${deadHash}.nar.zst`;
const deadNarinfoKey = `${deadHash}.narinfo`;
const deadKvNarinfoKey = `narinfo:${deadHash}`;

const startBody = {
  build: {
    id: BUILD_ID,
    host: HOST,
    system: "x86_64-linux",
    gitRev: "gcrev",
    flakeLockHash: "sha256:gclock",
    toplevelStorePath: `/nix/store/${GC_HASH}-pkg`,
    createdAt: 1700000200000,
  },
};

const liveStorePath = {
  storeHash: GC_HASH,
  storePath: `/nix/store/${GC_HASH}-pkg`,
  narinfoKey: `${GC_HASH}.narinfo`,
  narKey: liveNarKey,
  narHash: GC_NAR_HASH,
  narSize: 5000,
  fileHash: GC_FILE_HASH,
  fileSize: 2500,
  compression: "zstd",
};

const ingestBody = { storePaths: [liveStorePath] };

const finalizeBody = {
  manifest: {
    host: HOST,
    system: "x86_64-linux",
    gitRev: "gcrev",
    flakeLockHash: "sha256:gclock",
    toplevelStorePath: `/nix/store/${GC_HASH}-pkg`,
    closureJsonKey: "manifests/gc-test-build-001/closure.json",
    manifestKey: "manifests/gc-test-build-001/manifest.json",
    manifestHash: GC_MANIFEST_HASH,
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

// dead store_path を直接 D1 に INSERT するヘルパ（live build の closure には含めない）
async function insertDeadStorePath(
  db1: D1Database,
  input: {
    storeHash?: string;
    narKey?: string;
    fileHash?: string;
  } = {},
) {
  const storeHash = input.storeHash ?? deadHash;
  const narKey = input.narKey ?? deadNarKey;
  const fileHash = input.fileHash ?? "sha256:" + "e".repeat(64);
  await db1.prepare(
    `INSERT INTO store_paths (store_hash, store_path, narinfo_key, nar_key, nar_hash, nar_size, file_hash, file_size, compression, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    storeHash,
    `/nix/store/${storeHash}-dead`,
    `${storeHash}.narinfo`,
    narKey,
    "sha256:" + "d".repeat(64),
    9999,
    fileHash,
    4999,
    "zstd",
    Date.now(),
  ).run();
  // narinfo ファイルも追加
  await db1.prepare(
    `INSERT INTO nar_files (file_hash, nar_key, file_size, compression, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(fileHash, narKey, 4999, "zstd", Date.now()).run();
}

async function countRows(db1: D1Database, table: string, column: string, value: string) {
  const row = await db1.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`)
    .bind(value)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function putDeadObjects(eenv: Env, storeHash = deadHash, narKey = deadNarKey) {
  await eenv.META_KV.put(`narinfo:${storeHash}`, `StorePath: /nix/store/${storeHash}-dead`);
  await eenv.NAR_BUCKET.put(`${storeHash}.narinfo`, `StorePath: /nix/store/${storeHash}-dead`);
  await eenv.NAR_BUCKET.put(narKey, "dead nar");
}

beforeEach(async () => {
  const db1 = (env as unknown as Env).CONTROL_DB;
  await applyMigrations(db1);
  await cleanupTables(db1);
});

// ─── POST /api/gc/dry-run ─────────────────────────────────────────────────────

describe("POST /api/gc/dry-run（G8）", () => {
  test("published build なし: GC dry-run が 200 を返す", async () => {
    const res = await apiApp.fetch(
      makeWriteReq("/api/gc/dry-run", {}),
      authedEnv(),
    );
    // computeLiveSet は実装済みなので 200 を厳格に期待する
    expect(res.status).toBe(200);
  });

  test("published build なし: live_nar_keys は空配列", async () => {
    const res = await apiApp.fetch(
      makeWriteReq("/api/gc/dry-run", {}),
      authedEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Array.isArray(body["live_nar_keys"])).toBe(true);
    expect((body["live_nar_keys"] as string[]).length).toBe(0);
  });

  test("ADMIN_TOKEN なしで 403", async () => {
    const e = { ...(env as object) } as Record<string, unknown>;
    delete e["ADMIN_TOKEN"];
    const res = await apiApp.fetch(
      makeWriteReq("/api/gc/dry-run", {}),
      e as unknown as Env,
    );
    expect(res.status).toBe(403);
  });

  test("published build の NAR key が live_nar_keys に含まれる", async () => {
    const eenv = authedEnv();

    // publish フロー
    const startRes = await apiApp.fetch(makeWriteReq("/api/publish/start", startBody), eenv);
    expect(startRes.status).toBe(200);
    const ingestRes = await apiApp.fetch(
      makeWriteReq(`/api/publish/${BUILD_ID}/ingest`, ingestBody),
      eenv,
    );
    expect(ingestRes.status).toBe(200);
    const finalizeRes = await apiApp.fetch(
      makeWriteReq(`/api/publish/${BUILD_ID}/finalize`, finalizeBody),
      eenv,
    );
    expect(finalizeRes.status).toBe(200);

    // GC dry-run
    const res = await apiApp.fetch(
      makeWriteReq("/api/gc/dry-run", {}),
      eenv,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const liveKeys = body["live_nar_keys"] as string[];
    expect(Array.isArray(liveKeys)).toBe(true);
    expect(liveKeys).toContain(liveNarKey);
  });

  test("staging のみの build は live_nar_keys に含まれない", async () => {
    const eenv = authedEnv();

    // start のみ（finalize しない）
    const startRes = await apiApp.fetch(makeWriteReq("/api/publish/start", startBody), eenv);
    expect(startRes.status).toBe(200);
    const ingestRes = await apiApp.fetch(
      makeWriteReq(`/api/publish/${BUILD_ID}/ingest`, ingestBody),
      eenv,
    );
    expect(ingestRes.status).toBe(200);

    // GC dry-run
    const res = await apiApp.fetch(
      makeWriteReq("/api/gc/dry-run", {}),
      eenv,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const liveKeys = body["live_nar_keys"] as string[];
    // staging build は live set に入らない
    expect(liveKeys).not.toContain(liveNarKey);
  });

  test("dead_candidates に到達不能 NAR が含まれる", async () => {
    const eenv = authedEnv();
    const db1 = (env as unknown as Env).CONTROL_DB;

    // live build を publish
    await apiApp.fetch(makeWriteReq("/api/publish/start", startBody), eenv);
    await apiApp.fetch(makeWriteReq(`/api/publish/${BUILD_ID}/ingest`, ingestBody), eenv);
    await apiApp.fetch(makeWriteReq(`/api/publish/${BUILD_ID}/finalize`, finalizeBody), eenv);

    // dead store_path を直接 INSERT（どの live build の closure にも含まれない）
    await insertDeadStorePath(db1);

    const res = await apiApp.fetch(
      makeWriteReq("/api/gc/dry-run", {}),
      eenv,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const liveKeys = body["live_nar_keys"] as string[];
    const deadCandidates = body["dead_candidates"] as string[];

    expect(liveKeys).toContain(liveNarKey);
    expect(deadCandidates).toContain(deadNarKey);
    // live NAR は dead_candidates に入らない
    expect(deadCandidates).not.toContain(liveNarKey);
  });

  test("rollback_root として登録された staging build の NAR は live に含まれる（rollback 独立寄与）", async () => {
    const eenv = authedEnv();

    // Build A: published (live に含まれる）
    const BUILD_A_HASH = "aaaa1111aaaa1111bbbb2222bbbb2222";
    const BUILD_A_ID = "gc-rollback-build-A";
    const buildANarKey = `nar/${BUILD_A_HASH}.nar.zst`;

    const startBodyA = {
      build: {
        id: BUILD_A_ID,
        host: HOST,
        system: "x86_64-linux",
        gitRev: "revA",
        flakeLockHash: "sha256:lockA",
        toplevelStorePath: `/nix/store/${BUILD_A_HASH}-pkg`,
        createdAt: 1700000100000,
      },
    };
    const ingestBodyA = {
      storePaths: [{
        storeHash: BUILD_A_HASH,
        storePath: `/nix/store/${BUILD_A_HASH}-pkg`,
        narinfoKey: `${BUILD_A_HASH}.narinfo`,
        narKey: buildANarKey,
        narHash: "sha256:" + "1".repeat(64),
        narSize: 3000,
        fileHash: "sha256:" + "2".repeat(64),
        fileSize: 1500,
        compression: "zstd",
      }],
    };
    const finalizeBodyA = {
      manifest: {
        host: HOST,
        system: "x86_64-linux",
        gitRev: "revA",
        flakeLockHash: "sha256:lockA",
        toplevelStorePath: `/nix/store/${BUILD_A_HASH}-pkg`,
        closureJsonKey: `manifests/${BUILD_A_ID}/closure.json`,
        manifestKey: `manifests/${BUILD_A_ID}/manifest.json`,
        manifestHash: "sha256:" + "3".repeat(64),
      },
    };

    await apiApp.fetch(makeWriteReq("/api/publish/start", startBodyA), eenv);
    await apiApp.fetch(makeWriteReq(`/api/publish/${BUILD_A_ID}/ingest`, ingestBodyA), eenv);
    await apiApp.fetch(makeWriteReq(`/api/publish/${BUILD_A_ID}/finalize`, finalizeBodyA), eenv);

    // Build B: staging のまま（published しない）。rollback root に登録する。
    const BUILD_B_HASH = "cccc3333cccc3333dddd4444dddd4444";
    const BUILD_B_ID = "gc-rollback-build-B";
    const buildBNarKey = `nar/${BUILD_B_HASH}.nar.zst`;

    const startBodyB = {
      build: {
        id: BUILD_B_ID,
        host: HOST,
        system: "x86_64-linux",
        gitRev: "revB",
        flakeLockHash: "sha256:lockB",
        toplevelStorePath: `/nix/store/${BUILD_B_HASH}-pkg`,
        createdAt: 1700000050000,
      },
    };
    const ingestBodyB = {
      storePaths: [{
        storeHash: BUILD_B_HASH,
        storePath: `/nix/store/${BUILD_B_HASH}-pkg`,
        narinfoKey: `${BUILD_B_HASH}.narinfo`,
        narKey: buildBNarKey,
        narHash: "sha256:" + "4".repeat(64),
        narSize: 4000,
        fileHash: "sha256:" + "5".repeat(64),
        fileSize: 2000,
        compression: "zstd",
      }],
    };

    await apiApp.fetch(makeWriteReq("/api/publish/start", startBodyB), eenv);
    await apiApp.fetch(makeWriteReq(`/api/publish/${BUILD_B_ID}/ingest`, ingestBodyB), eenv);
    // finalize しない（staging のまま）

    // Build B を rollback_root に登録する
    const rollbackRes = await apiApp.fetch(
      makeWriteReq(`/api/hosts/${HOST}/rollback`, {
        build_id: BUILD_B_ID,
        reason: "rollback isolation test",
        pinned: true,
      }),
      eenv,
    );
    expect(rollbackRes.status).toBe(200);

    // GC dry-run
    const gcRes = await apiApp.fetch(
      makeWriteReq("/api/gc/dry-run", {}),
      eenv,
    );
    expect(gcRes.status).toBe(200);

    const body = await gcRes.json() as Record<string, unknown>;
    const liveKeys = body["live_nar_keys"] as string[];

    // Build A（published）の NAR は live に入る
    expect(liveKeys).toContain(buildANarKey);

    // Build B（staging だが rollback_root 登録）の NAR は live に含まれる
    // ここが rollback_roots 分岐の独立寄与を検証するポイント。
    // Build B は published でないため、rollback_roots テーブルの寄与がなければ dead になる。
    expect(liveKeys).toContain(buildBNarKey);
  });
});

// ─── POST /api/gc/execute ─────────────────────────────────────────────────────

describe("POST /api/gc/execute", () => {
  test("dry_run=true: 削除せず件数だけ返す", async () => {
    const eenv = authedEnv();
    const db1 = (env as unknown as Env).CONTROL_DB;
    await insertDeadStorePath(db1);
    await putDeadObjects(eenv);

    const res = await apiApp.fetch(
      makeWriteReq("/api/gc/execute", { dry_run: true }),
      eenv,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["phase"]).toBe("narinfo");
    expect(body["processed"]).toBe(1);
    expect(body["deleted"]).toEqual({
      kv_narinfo_attempted: 0,
      r2_narinfo_attempted: 0,
      r2_nar_attempted: 0,
      d1_store_paths: 0,
      d1_nar_files: 0,
      d1_build_closure: 0,
    });
    expect(await eenv.META_KV.get(deadKvNarinfoKey, "text")).not.toBeNull();
    expect(await eenv.NAR_BUCKET.get(deadNarinfoKey)).not.toBeNull();
    expect(await countRows(db1, "store_paths", "store_hash", deadHash)).toBe(1);
  });

  test("phase=narinfo: KV/R2 narinfo だけ削除する", async () => {
    const eenv = authedEnv();
    const db1 = (env as unknown as Env).CONTROL_DB;
    await insertDeadStorePath(db1);
    await putDeadObjects(eenv);

    const res = await apiApp.fetch(
      makeWriteReq("/api/gc/execute", { phase: "narinfo" }),
      eenv,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["deleted"]).toEqual({
      kv_narinfo_attempted: 1,
      r2_narinfo_attempted: 1,
      r2_nar_attempted: 0,
      d1_store_paths: 0,
      d1_nar_files: 0,
      d1_build_closure: 0,
    });
    expect(await eenv.META_KV.get(deadKvNarinfoKey, "text")).toBeNull();
    expect(await eenv.NAR_BUCKET.get(deadNarinfoKey)).toBeNull();
    expect(await eenv.NAR_BUCKET.get(deadNarKey)).not.toBeNull();
    expect(await countRows(db1, "store_paths", "store_hash", deadHash)).toBe(1);
    expect(await countRows(db1, "nar_files", "nar_key", deadNarKey)).toBe(1);
  });

  test("phase=narinfo: 同一 isolate のメモリキャッシュも破棄する", async () => {
    const eenv = authedEnv();
    const db1 = (env as unknown as Env).CONTROL_DB;
    await insertDeadStorePath(db1);
    await putDeadObjects(eenv);

    // L0 にロードさせる
    const warm = await handleNarinfo(eenv, deadHash);
    expect(warm.status).toBe(200);

    const res = await apiApp.fetch(
      makeWriteReq("/api/gc/execute", { phase: "narinfo" }),
      eenv,
    );

    expect(res.status).toBe(200);
    // KV / R2 / メモリすべて消えているはず → 404
    const stale = await handleNarinfo(eenv, deadHash);
    expect(stale.status).toBe(404);
  });

  test("phase=all: narinfo / NAR / D1 を削除し live NAR は残す", async () => {
    const eenv = authedEnv();
    const db1 = (env as unknown as Env).CONTROL_DB;

    await apiApp.fetch(makeWriteReq("/api/publish/start", startBody), eenv);
    await apiApp.fetch(makeWriteReq(`/api/publish/${BUILD_ID}/ingest`, ingestBody), eenv);
    await apiApp.fetch(makeWriteReq(`/api/publish/${BUILD_ID}/finalize`, finalizeBody), eenv);
    await eenv.NAR_BUCKET.put(liveNarKey, "live nar");

    await insertDeadStorePath(db1);
    await putDeadObjects(eenv);
    await db1.prepare(
      `INSERT INTO build_closure (build_id, store_hash) VALUES (?, ?)`
    ).bind("dead-build", deadHash).run();

    const res = await apiApp.fetch(
      makeWriteReq("/api/gc/execute", { phase: "all" }),
      eenv,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["dead_total"]).toBe(1);
    expect(body["processed"]).toBe(1);
    expect(body["dead_remaining"]).toBe(0);
    expect(body["deleted"]).toEqual({
      kv_narinfo_attempted: 1,
      r2_narinfo_attempted: 1,
      r2_nar_attempted: 1,
      d1_store_paths: 1,
      d1_nar_files: 1,
      d1_build_closure: 1,
    });
    expect(await eenv.META_KV.get(deadKvNarinfoKey, "text")).toBeNull();
    expect(await eenv.NAR_BUCKET.get(deadNarinfoKey)).toBeNull();
    expect(await eenv.NAR_BUCKET.get(deadNarKey)).toBeNull();
    expect(await eenv.NAR_BUCKET.get(liveNarKey)).not.toBeNull();
    expect(await countRows(db1, "store_paths", "store_hash", deadHash)).toBe(0);
    expect(await countRows(db1, "nar_files", "nar_key", deadNarKey)).toBe(0);
    expect(await countRows(db1, "build_closure", "store_hash", deadHash)).toBe(0);
  });

  test("max_deletes で処理件数を制限する", async () => {
    const eenv = authedEnv();
    const db1 = (env as unknown as Env).CONTROL_DB;
    const hashes = [
      "dead0001dead0001dead0001dead0001",
      "dead0002dead0002dead0002dead0002",
      "dead0003dead0003dead0003dead0003",
    ];

    for (const [index, storeHash] of hashes.entries()) {
      const narKey = `nar/${storeHash}.nar.zst`;
      await insertDeadStorePath(db1, {
        storeHash,
        narKey,
        fileHash: "sha256:" + String(index + 1).repeat(64),
      });
      await putDeadObjects(eenv, storeHash, narKey);
    }

    const res = await apiApp.fetch(
      makeWriteReq("/api/gc/execute", { phase: "all", max_deletes: 1 }),
      eenv,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["processed"]).toBe(1);
    expect(body["dead_remaining"]).toBe(2);

    const remaining = await db1.prepare("SELECT COUNT(*) AS count FROM store_paths").first<{ count: number }>();
    expect(remaining?.count).toBe(2);
    const remainingObjects = await Promise.all(
      hashes.map((storeHash) => eenv.NAR_BUCKET.get(`nar/${storeHash}.nar.zst`)),
    );
    expect(remainingObjects.filter((obj) => obj !== null)).toHaveLength(2);
  });

  test("ADMIN_TOKEN なしで 403", async () => {
    const e = { ...(env as object) } as Record<string, unknown>;
    delete e["ADMIN_TOKEN"];
    const res = await apiApp.fetch(
      makeWriteReq("/api/gc/execute", {}),
      e as unknown as Env,
    );
    expect(res.status).toBe(403);
  });

  test("dead が 0 件でも 200 と削除 0 件を返す", async () => {
    const res = await apiApp.fetch(
      makeWriteReq("/api/gc/execute", {}),
      authedEnv(),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["phase"]).toBe("narinfo");
    expect(body["dead_total"]).toBe(0);
    expect(body["processed"]).toBe(0);
    expect(body["deleted"]).toEqual({
      kv_narinfo_attempted: 0,
      r2_narinfo_attempted: 0,
      r2_nar_attempted: 0,
      d1_store_paths: 0,
      d1_nar_files: 0,
      d1_build_closure: 0,
    });
  });
});
