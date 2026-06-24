/**
 * test/integration/publish.test.ts
 *
 * publish 状態機械の統合テスト（実 D1）。
 * start → ingest → finalize の通しシナリオで実際のデータが D1 に書かれることを SQL SELECT で確認。
 *
 * 受入条件: A2/A3/A5/E1/E4 / G1/G2/G6
 *
 * NixOS 環境: steam-run npx vitest run --project integration
 */
import { beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { apiApp } from "../../src/api/app";
import * as schema from "../../src/db/schema";
import type { Env } from "../../src/types";

// ─── ヘルパ ─────────────────────────────────────────────────────────────────

/** テスト用 Db インスタンス */
function getDb() {
  return drizzle((env as unknown as Env).CONTROL_DB, { schema });
}

/**
 * テスト用の Authorization ヘッダ付きリクエストを作る。
 * ADMIN_TOKEN は miniflare では undefined になるため、フォールバックを設定しない
 * 統合テストは ADMIN_TOKEN を wrangler.toml の [vars] に入れず、
 * env に直接 inject する（vitest-pool-workers は isolatedStorage を使うため
 * 各テストで binding が独立）。
 */
function makeReq(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
) {
  const { method = "POST", body, token = "test-admin-token" } = opts;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
  return new Request(`https://example.com${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** ADMIN_TOKEN を inject した env */
function authedEnv() {
  return { ...(env as object), ADMIN_TOKEN: "test-admin-token" } as unknown as Env;
}

/** D1 に migration を適用する */
async function applyMigrations(db1: D1Database) {
  // ---> statement-breakpoint で分割して各文を実行
  const sql = `CREATE TABLE IF NOT EXISTS \`build_closure\` (
    \`build_id\` text NOT NULL,
    \`store_hash\` text NOT NULL,
    PRIMARY KEY(\`build_id\`, \`store_hash\`)
  );
  CREATE INDEX IF NOT EXISTS \`idx_build_closure_store\` ON \`build_closure\` (\`store_hash\`);
  CREATE TABLE IF NOT EXISTS \`build_manifests\` (
    \`build_id\` text PRIMARY KEY NOT NULL,
    \`host\` text NOT NULL,
    \`system\` text NOT NULL,
    \`git_rev\` text NOT NULL,
    \`flake_lock_hash\` text NOT NULL,
    \`toplevel_store_path\` text NOT NULL,
    \`closure_json_key\` text NOT NULL,
    \`manifest_key\` text NOT NULL,
    \`manifest_hash\` text NOT NULL,
    \`created_at\` integer NOT NULL
  );
  CREATE INDEX IF NOT EXISTS \`idx_build_manifests_host\` ON \`build_manifests\` (\`host\`, \`created_at\`);
  CREATE TABLE IF NOT EXISTS \`builds\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`host\` text NOT NULL,
    \`system\` text NOT NULL,
    \`git_rev\` text NOT NULL,
    \`flake_lock_hash\` text NOT NULL,
    \`toplevel_store_path\` text NOT NULL,
    \`status\` text DEFAULT 'staging' NOT NULL,
    \`retention_class\` text,
    \`created_at\` integer NOT NULL,
    \`published_at\` integer
  );
  CREATE INDEX IF NOT EXISTS \`idx_builds_host_published\` ON \`builds\` (\`host\`, \`published_at\`);
  CREATE TABLE IF NOT EXISTS \`nar_files\` (
    \`file_hash\` text PRIMARY KEY NOT NULL,
    \`nar_key\` text NOT NULL,
    \`file_size\` integer NOT NULL,
    \`compression\` text NOT NULL,
    \`created_at\` integer NOT NULL
  );
  CREATE TABLE IF NOT EXISTS \`rollback_roots\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`host\` text NOT NULL,
    \`build_id\` text NOT NULL,
    \`reason\` text,
    \`pinned\` integer DEFAULT 0 NOT NULL,
    \`keep_until\` integer,
    \`created_at\` integer NOT NULL
  );
  CREATE TABLE IF NOT EXISTS \`store_paths\` (
    \`store_hash\` text PRIMARY KEY NOT NULL,
    \`store_path\` text NOT NULL,
    \`narinfo_key\` text NOT NULL,
    \`nar_key\` text NOT NULL,
    \`nar_hash\` text NOT NULL,
    \`nar_size\` integer NOT NULL,
    \`file_hash\` text NOT NULL,
    \`file_size\` integer NOT NULL,
    \`compression\` text NOT NULL,
    \`first_seen_build_id\` text,
    \`created_at\` integer NOT NULL
  );`;

  const stmts = sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of stmts) {
    await db1.prepare(stmt).run();
  }
}

// ─── フィクスチャ ─────────────────────────────────────────────────────────────

const BUILD_ID = "integ-test-build-001";
const HOST = "test-host";

// フィクスチャ: 修正11の新しい制約（storePath/narKey/narHash/fileHash の形式制約）に合わせる。
// storeHash: Nix base32 小文字英数字 32 文字
const HASH1 = "aaaa0000aaaa0000bbbb1111bbbb1111";
const HASH2 = "cccc2222cccc2222dddd3333dddd3333";
const TOP_HASH = "aaaa0000aaaa0000bbbb1111bbbb1111";
// narHash/fileHash: sha256:<64桁 hex>
const NAR_HASH_1 = "sha256:" + "a".repeat(64);
const FILE_HASH_1 = "sha256:" + "b".repeat(64);
const NAR_HASH_2 = "sha256:" + "c".repeat(64);
const FILE_HASH_2 = "sha256:" + "d".repeat(64);
const MANIFEST_HASH = "sha256:" + "e".repeat(64);

const startBody = {
  build: {
    id: BUILD_ID,
    host: HOST,
    system: "x86_64-linux",
    gitRev: "deadbeef",
    flakeLockHash: "sha256:lock",
    toplevelStorePath: `/nix/store/${TOP_HASH}-pkg`,
    createdAt: 1700000000000,
  },
};

const storePath1 = {
  storeHash: HASH1,
  storePath: `/nix/store/${HASH1}-pkg`,
  narinfoKey: `${HASH1}.narinfo`,
  narKey: `nar/${HASH1}.nar.zst`,
  narHash: NAR_HASH_1,
  narSize: 1000,
  fileHash: FILE_HASH_1,
  fileSize: 500,
  compression: "zstd",
};

const storePath2 = {
  storeHash: HASH2,
  storePath: `/nix/store/${HASH2}-dep`,
  narinfoKey: `${HASH2}.narinfo`,
  narKey: `nar/${HASH2}.nar.zst`,
  narHash: NAR_HASH_2,
  narSize: 2000,
  fileHash: FILE_HASH_2,
  fileSize: 900,
  compression: "zstd",
};

const ingestBody = { storePaths: [storePath1, storePath2] };

const finalizeBody = {
  manifest: {
    host: HOST,
    system: "x86_64-linux",
    gitRev: "deadbeef",
    flakeLockHash: "sha256:lock",
    toplevelStorePath: `/nix/store/${TOP_HASH}-pkg`,
    closureJsonKey: "manifests/integ-test-build-001/closure.json",
    manifestKey: "manifests/integ-test-build-001/manifest.json",
    manifestHash: MANIFEST_HASH,
  },
};

// ─── before each: migration & clean ─────────────────────────────────────────

/**
 * vitest-pool-workers v0.16 では isolatedStorage がテストファイル単位でリセットされるため、
 * テスト間でデータが共有される。beforeEach で全テーブルを DELETE してリセットする。
 */
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

// ─── 基本フロー（start → ingest → finalize） ─────────────────────────────────

describe("publish 基本フロー（G1/G2/A3）", () => {
  test("POST /api/publish/start が 200 で build_id を返す", async () => {
    const res = await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      authedEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["build_id"]).toBe(BUILD_ID);
  });

  test("finalize 前: getLatestBuild は staging build を返さない（G1）", async () => {
    // start のみ実行
    await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      authedEnv(),
    );

    const db = getDb();
    const { getLatestBuild } = await import("../../src/db/queries");
    const latest = await getLatestBuild(db, HOST);
    // staging build があるが latest は published のみ → null
    expect(latest).toBeNull();
  });

  test("POST /api/publish/:buildId/ingest が 200 を返す", async () => {
    await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      authedEnv(),
    );

    const res = await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/ingest`, { body: ingestBody }),
      authedEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(typeof body["ingested"]).toBe("number");
  });

  test("POST /api/publish/:buildId/finalize が 200 で published_at を返す", async () => {
    await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      authedEnv(),
    );
    await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/ingest`, { body: ingestBody }),
      authedEnv(),
    );

    const res = await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/finalize`, { body: finalizeBody }),
      authedEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(typeof body["published_at"]).toBe("number");
    expect(body["published_at"] as number).toBeGreaterThan(0);
  });

  test("finalize 後: getLatestBuild が published build を返す（G2）", async () => {
    await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      authedEnv(),
    );
    await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/ingest`, { body: ingestBody }),
      authedEnv(),
    );
    await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/finalize`, { body: finalizeBody }),
      authedEnv(),
    );

    const db = getDb();
    const { getLatestBuild } = await import("../../src/db/queries");
    const latest = await getLatestBuild(db, HOST);
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(BUILD_ID);
    expect(latest!.status).toBe("published");
    expect(latest!.publishedAt).not.toBeNull();
    expect(latest!.publishedAt!).toBeGreaterThan(0);
  });

  test("finalize 後: D1 に builds 行が published で存在する（実 SQL 確認）", async () => {
    await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      authedEnv(),
    );
    await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/ingest`, { body: ingestBody }),
      authedEnv(),
    );
    await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/finalize`, { body: finalizeBody }),
      authedEnv(),
    );

    const db = getDb();
    const rows = await db
      .select()
      .from(schema.builds)
      .where(eq(schema.builds.id, BUILD_ID));

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.status).toBe("published");
    expect(row?.host).toBe(HOST);
    expect(row?.publishedAt).toBeGreaterThan(0);
  });

  test("finalize 後: D1 に store_paths 行が実際に INSERT されている（実 SQL 確認）", async () => {
    await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      authedEnv(),
    );
    await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/ingest`, { body: ingestBody }),
      authedEnv(),
    );
    await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/finalize`, { body: finalizeBody }),
      authedEnv(),
    );

    const db = getDb();
    const sp1 = await db
      .select()
      .from(schema.storePaths)
      .where(eq(schema.storePaths.storeHash, storePath1.storeHash));

    expect(sp1).toHaveLength(1);
    expect(sp1[0]?.storeHash).toBe(storePath1.storeHash);
    expect(sp1[0]?.narSize).toBe(storePath1.narSize);
    expect(sp1[0]?.narKey).toBe(storePath1.narKey);

    const sp2 = await db
      .select()
      .from(schema.storePaths)
      .where(eq(schema.storePaths.storeHash, storePath2.storeHash));

    expect(sp2).toHaveLength(1);
    expect(sp2[0]?.storeHash).toBe(storePath2.storeHash);
  });

  test("finalize 後: D1 に nar_files 行が実際に INSERT されている（実 SQL 確認）", async () => {
    await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      authedEnv(),
    );
    await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/ingest`, { body: ingestBody }),
      authedEnv(),
    );
    await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/finalize`, { body: finalizeBody }),
      authedEnv(),
    );

    const db = getDb();
    const nf1 = await db
      .select()
      .from(schema.narFiles)
      .where(eq(schema.narFiles.fileHash, storePath1.fileHash));

    expect(nf1).toHaveLength(1);
    expect(nf1[0]?.fileSize).toBe(storePath1.fileSize);

    const nf2 = await db
      .select()
      .from(schema.narFiles)
      .where(eq(schema.narFiles.fileHash, storePath2.fileHash));

    expect(nf2).toHaveLength(1);
  });

  test("finalize 後: D1 に build_closure 行が実際に INSERT されている（実 SQL 確認）", async () => {
    await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      authedEnv(),
    );
    await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/ingest`, { body: ingestBody }),
      authedEnv(),
    );
    await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/finalize`, { body: finalizeBody }),
      authedEnv(),
    );

    const db = getDb();
    const closure = await db
      .select()
      .from(schema.buildClosure)
      .where(eq(schema.buildClosure.buildId, BUILD_ID));

    // 2 つの store path が closure に含まれる
    expect(closure).toHaveLength(2);
    const hashes = closure.map((r) => r.storeHash).sort();
    expect(hashes).toEqual([storePath1.storeHash, storePath2.storeHash].sort());
  });

  test("finalize 後: D1 に build_manifests 行が INSERT されている（実 SQL 確認）", async () => {
    await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      authedEnv(),
    );
    await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/ingest`, { body: ingestBody }),
      authedEnv(),
    );
    await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/finalize`, { body: finalizeBody }),
      authedEnv(),
    );

    const db = getDb();
    const manifests = await db
      .select()
      .from(schema.buildManifests)
      .where(eq(schema.buildManifests.buildId, BUILD_ID));

    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.manifestHash).toBe(finalizeBody.manifest.manifestHash);
    expect(manifests[0]?.host).toBe(HOST);
  });
});

// ─── 冪等性テスト（G6） ──────────────────────────────────────────────────────

describe("冪等性（G6）", () => {
  test("start 再送は冪等（200 で同じ build_id）", async () => {
    const eenv = authedEnv();

    // 1 回目
    const res1 = await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      eenv,
    );
    expect(res1.status).toBe(200);
    const b1 = await res1.json() as Record<string, unknown>;

    // 2 回目（同一 payload）
    const res2 = await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      eenv,
    );
    expect(res2.status).toBe(200);
    const b2 = await res2.json() as Record<string, unknown>;

    expect(b2["build_id"]).toBe(b1["build_id"]);
  });

  test("ingest 同一 payload 再送は冪等（200）", async () => {
    const eenv = authedEnv();

    await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      eenv,
    );

    // 1 回目
    const res1 = await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/ingest`, { body: ingestBody }),
      eenv,
    );
    expect(res1.status).toBe(200);

    // 2 回目（同一 payload）
    const res2 = await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/ingest`, { body: ingestBody }),
      eenv,
    );
    expect(res2.status).toBe(200);

    // DB 行は重複しない（onConflictDoNothing）
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.storePaths)
      .where(eq(schema.storePaths.storeHash, storePath1.storeHash));
    expect(rows).toHaveLength(1);
  });

  test("ingest 差分 payload（narSize 違い）は 409（G6）", async () => {
    const eenv = authedEnv();

    await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      eenv,
    );
    // 1 回目: 正常 ingest
    await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/ingest`, { body: ingestBody }),
      eenv,
    );

    // 2 回目: 既存 storeHash で narSize が異なる → 409
    const diffPayload = {
      storePaths: [
        { ...storePath1, narSize: 99999 }, // narSize が違う
      ],
    };
    const res = await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/ingest`, { body: diffPayload }),
      eenv,
    );
    expect(res.status).toBe(409);
  });

  test("finalize 再送は冪等（200）", async () => {
    const eenv = authedEnv();

    await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      eenv,
    );
    await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/ingest`, { body: ingestBody }),
      eenv,
    );

    // 1 回目
    const res1 = await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/finalize`, { body: finalizeBody }),
      eenv,
    );
    expect(res1.status).toBe(200);

    // 2 回目（同一 payload）
    const res2 = await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/finalize`, { body: finalizeBody }),
      eenv,
    );
    expect(res2.status).toBe(200);
  });

  test("finalize 後に ingest すると 409", async () => {
    const eenv = authedEnv();

    await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      eenv,
    );
    await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/ingest`, { body: ingestBody }),
      eenv,
    );
    await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/finalize`, { body: finalizeBody }),
      eenv,
    );

    // finalize 後に新しい store path を ingest しようとする
    const NEW_HASH = "eeee4444eeee4444ffff5555ffff5555";
    const newStorePath = {
      storePaths: [
        {
          storeHash: NEW_HASH,
          storePath: `/nix/store/${NEW_HASH}-new`,
          narinfoKey: `${NEW_HASH}.narinfo`,
          narKey: `nar/${NEW_HASH}.nar.zst`,
          narHash: "sha256:" + "f".repeat(64),
          narSize: 3000,
          fileHash: "sha256:" + "0".repeat(64),
          fileSize: 1500,
          compression: "zstd",
        },
      ],
    };
    const res = await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/ingest`, { body: newStorePath }),
      eenv,
    );
    expect(res.status).toBe(409);
  });
});

// ─── zod 入力検証（B4） ──────────────────────────────────────────────────────

describe("入力検証（B4）", () => {
  test("start: narSize が 0 の store path は 400", async () => {
    const eenv = authedEnv();
    await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      eenv,
    );

    const badPayload = {
      storePaths: [{ ...storePath1, narSize: 0 }],
    };
    const res = await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/ingest`, { body: badPayload }),
      eenv,
    );
    expect(res.status).toBe(400);
  });

  test("start: narSize が負数の store path は 400", async () => {
    const eenv = authedEnv();
    await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      eenv,
    );

    const badPayload = {
      storePaths: [{ ...storePath1, narSize: -1 }],
    };
    const res = await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/ingest`, { body: badPayload }),
      eenv,
    );
    expect(res.status).toBe(400);
  });

  test("start: storeHash に大文字を含む場合は 400", async () => {
    const eenv = authedEnv();
    await apiApp.fetch(
      makeReq("/api/publish/start", { body: startBody }),
      eenv,
    );

    const badPayload = {
      storePaths: [{ ...storePath1, storeHash: "AAAA0000aaaa0000" }],
    };
    const res = await apiApp.fetch(
      makeReq(`/api/publish/${BUILD_ID}/ingest`, { body: badPayload }),
      eenv,
    );
    expect(res.status).toBe(400);
  });

  test("start: 必須フィールド欠落（host なし）は 400", async () => {
    const res = await apiApp.fetch(
      makeReq("/api/publish/start", {
        body: { build: { ...startBody.build, host: undefined } },
      }),
      authedEnv(),
    );
    expect(res.status).toBe(400);
  });
});
