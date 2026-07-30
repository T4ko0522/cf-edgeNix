import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import type { Env } from "../../types";
import { adminAuthMiddleware } from "../middleware/auth";
import {
  ApiErrorSchema,
  GcBackfillRequestSchema,
  GcBackfillResponseSchema,
  GcDryRunResponseSchema,
  GcExecuteRequestSchema,
  GcExecuteResponseSchema,
} from "../../schemas/api";
import { getDb } from "../../db/client";
import {
  backfillClosureNarKeys,
  computeLiveSet,
  countPendingClosureBackfills,
  confirmNarinfoDeleted,
  deleteGcMarks,
  deleteLiveGcMarks,
  deleteDeadStorePaths,
  listGraceElapsedNarKeys,
  listDeadStorePaths,
  listPendingNarinfoKeys,
  listPendingClosureBackfills,
  markBuildsPrunedForNarKeys,
  markGcCandidates,
} from "../../db/queries";
import { narinfoKVKey } from "../../storage/keys";
import { deleteText as deleteKvText } from "../../storage/kv";
import { deleteObjects } from "../../storage/r2";
import { getText } from "../../storage/r2";
import { purgeTags, purgerFrom } from "../../cache/purge";

const gcApp = new OpenAPIHono<{ Bindings: Env }>();

const gcDryRunRoute = createRoute({
  method: "post",
  path: "/api/gc/dry-run",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: GcDryRunResponseSchema } },
      description: "GC dry-run 成功",
    },
    401: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description: "認証失敗",
    },
    403: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description: "ADMIN_TOKEN 未設定",
    },
  },
});

const gcExecuteRoute = createRoute({
  method: "post",
  path: "/api/gc/execute",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: GcExecuteRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: GcExecuteResponseSchema } },
      description: "GC execute 成功",
    },
    400: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description: "入力不正",
    },
    401: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description: "認証失敗",
    },
    403: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description: "ADMIN_TOKEN 未設定",
    },
  },
});

const gcBackfillRoute = createRoute({
  method: "post",
  path: "/api/gc/backfill",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: GcBackfillRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: GcBackfillResponseSchema } },
      description: "旧 build closure の NAR 参照を manifest から復元",
    },
    401: { content: { "application/json": { schema: ApiErrorSchema } }, description: "認証失敗" },
    403: { content: { "application/json": { schema: ApiErrorSchema } }, description: "ADMIN_TOKEN 未設定" },
  },
});

const StoredManifestSchema = z.object({
  buildId: z.string(),
  storePaths: z.array(z.object({
    storeHash: z.string(),
    narKey: z.string().regex(/^nar\/[0-9a-z]+\.nar(\.(xz|zst|gz|br))?$/),
  })),
});

function manifestHashMatches(expected: string, digest: Uint8Array): boolean {
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (expected === `sha256:${hex}`) return true;
  const base64 = btoa(String.fromCharCode(...digest));
  if (expected === `sha256-${base64}`) return true;

  const alphabet = "0123456789abcdfghijklmnpqrsvwxyz";
  let nixBase32 = "";
  for (let index = 0; index < Math.ceil(digest.length * 8 / 5); index++) {
    const bit = index * 5;
    const byte = Math.floor(bit / 8);
    const shift = bit % 8;
    const value = (digest[byte]! >> shift) |
      (byte + 1 < digest.length ? digest[byte + 1]! << (8 - shift) : 0);
    nixBase32 = alphabet[value & 0x1f] + nixBase32;
  }
  return expected === `sha256:${nixBase32}`;
}

gcApp.use("/api/gc/*", adminAuthMiddleware);

gcApp.openapi(gcDryRunRoute, async (c) => {
  const db = getDb(c.env);
  const liveSet = await computeLiveSet(db);
  return c.json({
    live_nar_keys: liveSet.liveNarKeys,
    dead_candidates: liveSet.deadCandidates,
  }, 200);
});

gcApp.openapi(gcBackfillRoute, async (c) => {
  const db = getDb(c.env);
  const { max_rows: maxRows, cursor } = c.req.valid("json");
  const separator = cursor?.lastIndexOf(":") ?? -1;
  const after = cursor && separator > 0
    ? { buildId: cursor.slice(0, separator), storeHash: cursor.slice(separator + 1) }
    : undefined;
  const pending = await listPendingClosureBackfills(db, maxRows, after);
  const errors: Array<{ build_id: string; error: string }> = [];
  let updated = 0;
  const byBuild = new Map<string, typeof pending>();
  for (const row of pending) {
    const rows = byBuild.get(row.buildId) ?? [];
    rows.push(row);
    byBuild.set(row.buildId, rows);
  }

  for (const [buildId, rows] of byBuild) {
    try {
      const metadata = rows[0];
      if (!metadata?.manifestKey || !metadata.manifestHash) {
        throw new Error("build manifest metadata not found");
      }
      const text = await getText(c.env, metadata.manifestKey);
      if (text === null) throw new Error("manifest object not found");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
      if (!manifestHashMatches(metadata.manifestHash, digest)) {
        throw new Error("manifest hash mismatch");
      }
      const manifest = StoredManifestSchema.parse(JSON.parse(text));
      if (manifest.buildId !== buildId) throw new Error("manifest buildId mismatch");
      const byStoreHash = new Map(manifest.storePaths.map((row) => [row.storeHash, row.narKey]));
      const updates = rows.map((row) => {
        const narKey = byStoreHash.get(row.storeHash);
        if (!narKey) throw new Error(`manifest is missing store hash ${row.storeHash}`);
        return { storeHash: row.storeHash, narKey };
      });
      updated += await backfillClosureNarKeys(db, buildId, updates);
    } catch (error) {
      errors.push({
        build_id: buildId,
        error: error instanceof Error ? error.message : "unknown backfill error",
      });
    }
  }

  return c.json({
    ok: true as const,
    builds_processed: byBuild.size,
    closure_rows_updated: updated,
    closure_rows_remaining: await countPendingClosureBackfills(db),
    next_cursor: pending.length === maxRows && pending.length > 0
      ? `${pending.at(-1)?.buildId}:${pending.at(-1)?.storeHash}`
      : null,
    errors,
  }, 200);
});

gcApp.openapi(gcExecuteRoute, async (c) => {
  const db = getDb(c.env);
  const body = c.req.valid("json");
  const runWithConcurrency = async <T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> => {
    const queue = [...items];
    while (queue.length) {
      await Promise.all(queue.splice(0, limit).map(fn));
    }
  };
  const liveSet = await computeLiveSet(db);
  const phaseCandidates = body.phase === "narinfo"
    ? await listPendingNarinfoKeys(db, liveSet.deadCandidates)
    : await listGraceElapsedNarKeys(db, liveSet.deadCandidates);
  const deadTotal = phaseCandidates.length;
  const targetNarKeys = phaseCandidates.slice(0, body.max_deletes);
  // dead = store_paths が指す dead な narKey / orphan = ingest upsert で
  // 置き換わり store_paths から見えなくなった nar_files 側の残骸。
  const processed = targetNarKeys.length;
  const deadRemaining = Math.max(deadTotal - processed, 0);
  const deleted = {
    kv_narinfo_attempted: 0,
    r2_narinfo_attempted: 0,
    r2_nar_attempted: 0,
    d1_store_paths: 0,
    d1_nar_files: 0,
    d1_build_closure: 0,
    d1_builds_pruned: 0,
  };
  let edgePurgeAttempted = 0;

  if (body.dry_run) {
    return c.json({
      ok: true as const,
      phase: body.phase,
      dry_run: true,
      dead_total: deadTotal,
      processed,
      dead_remaining: deadRemaining,
      deleted,
      edge_purge_attempted: 0,
    }, 200);
  }

  await deleteLiveGcMarks(db, liveSet.liveNarKeys);

  // Workers Cache のタグ purge（best-effort）。executionCtx が無いランタイム
  // （vitest で ctx 未指定の場合など）でも throw させない。
  let purger: ReturnType<typeof purgerFrom> = null;
  try {
    purger = purgerFrom(c.executionCtx);
  } catch {
    // executionCtx 不在は purge 非対応として扱う
  }

  // narinfo を先に消し、NAR は後に消す。
  if (body.phase === "narinfo") {
    await markGcCandidates(db, targetNarKeys);
    const refreshed = await computeLiveSet(db);
    const stillDead = new Set(refreshed.deadCandidates);
    const safeNarKeys = targetNarKeys.filter((key) => stillDead.has(key));
    await deleteGcMarks(db, targetNarKeys.filter((key) => !stillDead.has(key)));
    const safeDead = await listDeadStorePaths(db, safeNarKeys);
    const uniqueStoreHashes = [...new Set(safeDead.map((row) => row.storeHash))];
    const uniqueNarinfoKeys = [...new Set(safeDead.map((row) => row.narinfoKey))];
    await runWithConcurrency(
      uniqueStoreHashes,
      50,
      async (storeHash) => {
        await deleteKvText(c.env, narinfoKVKey(storeHash));
      },
    );
    await deleteObjects(c.env, uniqueNarinfoKeys);
    await confirmNarinfoDeleted(db, safeNarKeys);
    deleted.kv_narinfo_attempted = uniqueStoreHashes.length;
    deleted.r2_narinfo_attempted = uniqueNarinfoKeys.length;
    // edge の narinfo（positive / negative 両エントリ）を無効化する。
    edgePurgeAttempted += await purgeTags(
      purger,
      uniqueStoreHashes.map((h) => `narinfo:${h}`),
    );
  }

  if (body.phase === "nar") {
    // pin/rollback/publish が mark 後に入った場合に備え、物理削除の直前に再判定する。
    const refreshed = await computeLiveSet(db);
    const stillDead = new Set(refreshed.deadCandidates);
    const safeNarKeys = targetNarKeys.filter((key) => stillDead.has(key));
    const revivedNarKeys = targetNarKeys.filter((key) => !stillDead.has(key));
    await deleteGcMarks(db, revivedNarKeys);
    const safeDead = await listDeadStorePaths(db, safeNarKeys);
    // orphan は store_paths を持たないため storeHash は dead 由来のみ。
    const uniqueNarKeys = [...new Set(safeNarKeys)];
    const buildsPruned = await markBuildsPrunedForNarKeys(db, uniqueNarKeys);
    await deleteObjects(c.env, uniqueNarKeys);
    const d1Deleted = await deleteDeadStorePaths(
      db,
      safeDead,
      uniqueNarKeys,
    );
    deleted.r2_nar_attempted = uniqueNarKeys.length;
    deleted.d1_store_paths = d1Deleted.storePathsDeleted;
    deleted.d1_nar_files = d1Deleted.narFilesDeleted;
    deleted.d1_build_closure = d1Deleted.buildClosureDeleted;
    deleted.d1_builds_pruned = buildsPruned;
    // edge の NAR エントリ（immutable long TTL）を無効化する。タグは nar:<fileName>。
    edgePurgeAttempted += await purgeTags(
      purger,
      uniqueNarKeys.map((k) => `nar:${k.replace(/^nar\//, "")}`),
    );
  }

  return c.json({
    ok: true as const,
    phase: body.phase,
    dry_run: false,
    dead_total: deadTotal,
    processed,
    dead_remaining: deadRemaining,
    deleted,
    edge_purge_attempted: edgePurgeAttempted,
  }, 200);
});

export { gcApp };
