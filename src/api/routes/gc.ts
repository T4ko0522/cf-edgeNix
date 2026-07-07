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
import { computeLiveSet, deleteDeadStorePaths, listDeadStorePaths } from "../../db/queries";
import { narinfoKVKey } from "../../storage/keys";
import { deleteText as deleteKvText } from "../../storage/kv";
import { deleteObjects } from "../../storage/r2";

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

gcApp.openapi(gcDryRunRoute, async (c) => {
  const db = getDb(c.env);
  const liveSet = await computeLiveSet(db);
  return c.json({
    live_nar_keys: liveSet.liveNarKeys,
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
  const liveSet = await computeLiveSet(db);
  const deadTotal = liveSet.deadCandidates.length;
  const targetNarKeys = liveSet.deadCandidates.slice(0, body.max_deletes);
  const dead = await listDeadStorePaths(db, targetNarKeys);
  const processed = dead.length;
  const deadRemaining = Math.max(deadTotal - processed, 0);
  const deleted = {
    kv_narinfo_attempted: 0,
    r2_narinfo_attempted: 0,
    r2_nar_attempted: 0,
    d1_store_paths: 0,
    d1_nar_files: 0,
    d1_build_closure: 0,
  };

  if (body.dry_run) {
    return c.json({
      ok: true as const,
      phase: body.phase,
      dry_run: true,
      dead_total: deadTotal,
      processed,
      dead_remaining: deadRemaining,
      deleted,
    }, 200);
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
  }

  if (body.phase === "nar" || body.phase === "all") {
    const uniqueNarKeys = [...new Set(dead.map((d) => d.narKey))];
    const uniqueFileHashes = [...new Set(dead.map((d) => d.fileHash))];
    await deleteObjects(c.env, uniqueNarKeys);
    const d1Deleted = await deleteDeadStorePaths(db, storeHashes, uniqueFileHashes);
    deleted.r2_nar_attempted = uniqueNarKeys.length;
    deleted.d1_store_paths = d1Deleted.storePathsDeleted;
    deleted.d1_nar_files = d1Deleted.narFilesDeleted;
    deleted.d1_build_closure = d1Deleted.buildClosureDeleted;
  }

  return c.json({
    ok: true as const,
    phase: body.phase,
    dry_run: false,
    dead_total: deadTotal,
    processed,
    dead_remaining: deadRemaining,
    deleted,
  }, 200);
});

export { gcApp };
