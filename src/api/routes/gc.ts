import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Env } from "../../types";
import { adminAuthMiddleware } from "../middleware/auth";
import {
  ApiErrorSchema,
  GcDryRunResponseSchema,
  GcExecuteRequestSchema,
  GcExecuteResponseSchema,
} from "../../schemas/api";
import { getDb } from "../../db/client";
import {
  computeLiveSet,
  deleteBuildHistory,
  deleteDeadStorePaths,
  deleteGcMarks,
  deleteStaleGcMarks,
  listCollectableBuilds,
  listMarkedDeadStorePaths,
  listOrphanedNarFiles,
  listReclaimableNarFiles,
  listUnmarkedDeadStorePaths,
  markStorePathsForGc,
} from "../../db/queries";
import { narinfoKVKey } from "../../storage/keys";
import { deleteText as deleteKvText } from "../../storage/kv";
import { deleteObjects } from "../../storage/r2";
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

gcApp.use("/api/gc/*", adminAuthMiddleware);

/** 不正値は安全側の既定値 3。0 は published 世代を保護しない明示値。 */
function keepGenerations(env: Env): number {
  const value = env.GC_KEEP_GENERATIONS;
  if (value === undefined) return 3;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return 3;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 3;
}

gcApp.openapi(gcDryRunRoute, async (c) => {
  const db = getDb(c.env);
  const liveSet = await computeLiveSet(db, keepGenerations(c.env));
  return c.json({
    live_nar_keys: liveSet.liveNarKeys,
    dead_store_paths: liveSet.deadStorePaths.map((path) => ({
      store_hash: path.storeHash,
      narinfo_key: path.narinfoKey,
      nar_key: path.narKey,
    })),
    dead_build_ids: liveSet.deadBuildIds,
    dead_candidates: liveSet.deadCandidates,
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
  const liveSet = await computeLiveSet(db, keepGenerations(c.env));
  // dry-run は D1 を含む外部状態を一切変更しない。stale mark は helper が
  // dead store path と突き合わせて自然に除外するため、表示結果にも影響しない。
  if (!body.dry_run) {
    await deleteStaleGcMarks(
      db,
      liveSet.deadStorePaths.map((path) => path.storeHash),
    );
  }
  const allOrphans = await listOrphanedNarFiles(db, liveSet.deadCandidates);
  // max_deletes は store path / orphan NAR の work item 数。NAR共有時でも dead
  // narinfo を前進させ、共有 NAR は最後の参照が消えた呼び出しでのみ回収する。
  const markedDead = await listMarkedDeadStorePaths(
    db,
    liveSet.deadStorePaths,
  );
  const unmarkedDead = await listUnmarkedDeadStorePaths(
    db,
    liveSet.deadStorePaths,
  );
  // phase ごとに eligible な全 work item を決めてから route でbatch化する。
  // narinfo は未mark store path のみ、nar はmark済み pathとorphan、all は
  // mark状態を問わない全pathとorphanを即時回収する。
  const candidates = body.phase === "narinfo"
    ? unmarkedDead
    : body.phase === "nar"
    ? [...markedDead, ...allOrphans]
    : [...markedDead, ...unmarkedDead, ...allOrphans];
  const batch = candidates.slice(0, body.max_deletes);
  const dead = batch.filter((item): item is typeof markedDead[number] => "storeHash" in item);
  const orphan = batch.filter((item): item is typeof allOrphans[number] => !("storeHash" in item));
  const deadTotal = candidates.length;
  const processed = batch.length;
  const deadRemaining = Math.max(deadTotal - processed, 0);
  const buildTotal = liveSet.deadBuildIds.length;
  const targetBuildIds = body.phase === "narinfo"
    ? []
    : liveSet.deadBuildIds.slice(0, body.max_deletes);
  const buildProcessed = targetBuildIds.length;
  const buildRemaining = buildTotal - buildProcessed;
  const deleted = {
    kv_narinfo_attempted: 0,
    r2_narinfo_attempted: 0,
    r2_nar_attempted: 0,
    d1_store_paths: 0,
    d1_nar_files: 0,
    d1_build_closure: 0,
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
      build_total: buildTotal,
      build_processed: buildProcessed,
      build_remaining: buildRemaining,
      deleted,
      edge_purge_attempted: 0,
    }, 200);
  }

  // Workers Cache のタグ purge（best-effort）。executionCtx が無いランタイム
  // （vitest で ctx 未指定の場合など）でも throw させない。
  let purger: ReturnType<typeof purgerFrom> = null;
  try {
    purger = purgerFrom(c.executionCtx);
  } catch {
    // executionCtx 不在は purge 非対応として扱う
  }

  const storeHashes = dead.map((d) => d.storeHash);
  const uniqueStoreHashes = [...new Set(storeHashes)];

  // narinfo を先に消し、NAR は後に消す。
  if (body.phase === "narinfo" || body.phase === "all") {
    const uniqueNarinfoKeys = [...new Set(dead.map((d) => d.narinfoKey))];
    await runWithConcurrency(
      uniqueStoreHashes,
      50,
      async (storeHash) => {
        await deleteKvText(c.env, narinfoKVKey(storeHash));
      },
    );
    await deleteObjects(c.env, uniqueNarinfoKeys);
    deleted.kv_narinfo_attempted = uniqueStoreHashes.length;
    deleted.r2_narinfo_attempted = uniqueNarinfoKeys.length;
    await markStorePathsForGc(db, uniqueStoreHashes);
    // edge の narinfo（positive / negative 両エントリ）を無効化する。
    edgePurgeAttempted += await purgeTags(
      purger,
      uniqueStoreHashes.map((h) => `narinfo:${h}`),
    );
  }

  if (body.phase === "nar" || body.phase === "all") {
    // 同じ narKey を live store path が参照中なら R2/NAR 行は消さない。dead
    // store path 自身は narKey 共有の有無にかかわらず回収する。
    const reclaimable = await listReclaimableNarFiles(db, dead, orphan);
    const uniqueNarKeys = reclaimable.narKeys;
    const uniqueFileHashes = reclaimable.fileHashes;
    await deleteObjects(c.env, uniqueNarKeys);
    const d1Deleted = await deleteDeadStorePaths(db, storeHashes, uniqueFileHashes);
    deleted.r2_nar_attempted = uniqueNarKeys.length;
    deleted.d1_store_paths = d1Deleted.storePathsDeleted;
    deleted.d1_nar_files = d1Deleted.narFilesDeleted;
    deleted.d1_build_closure = d1Deleted.buildClosureDeleted;
    await deleteGcMarks(db, storeHashes);
    // edge の NAR エントリ（immutable long TTL）を無効化する。タグは nar:<fileName>。
    edgePurgeAttempted += await purgeTags(
      purger,
      uniqueNarKeys.map((k) => `nar:${k.replace(/^nar\//, "")}`),
    );

    // R2 と D1 は原子的に削除できないため、R2 を先に削除する。D1 削除に失敗しても
    // dead build と manifest key が残るので、同じ GC を再実行して回復できる。
    const collectable = await listCollectableBuilds(db, targetBuildIds);
    if (collectable.closureJsonKeys.length || collectable.manifestKeys.length) {
      await deleteObjects(
        c.env,
        [...collectable.closureJsonKeys, ...collectable.manifestKeys],
      );
    }
    await deleteBuildHistory(db, targetBuildIds);
  }

  return c.json({
    ok: true as const,
    phase: body.phase,
    dry_run: false,
    dead_total: deadTotal,
    processed,
    dead_remaining: deadRemaining,
    build_total: buildTotal,
    build_processed: buildProcessed,
    build_remaining: buildRemaining,
    deleted,
    edge_purge_attempted: edgePurgeAttempted,
  }, 200);
});

export { gcApp };
