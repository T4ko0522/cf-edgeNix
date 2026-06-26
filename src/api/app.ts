import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { adminAuthMiddleware } from "./middleware/auth";
import {
  BuildIdSchema,
  HostSchema,
} from "../schemas/params";
import {
  ApiErrorSchema,
  BuildsListResponseSchema,
  GcDryRunResponseSchema,
  GcExecuteRequestSchema,
  GcExecuteResponseSchema,
  LatestBuildResponseSchema,
  ManifestJsonResponseSchema,
  RollbackRequestSchema,
  RollbackResponseSchema,
} from "../schemas/api";
import {
  PublishFinalizeRequestSchema,
  PublishFinalizeResponseSchema,
  PublishIngestRequestSchema,
  PublishIngestResponseSchema,
  PublishStartRequestSchema,
  PublishStartResponseSchema,
} from "../schemas/publish";
import {
  QuotaAdminStatusResponseSchema,
  QuotaPublicStatusResponseSchema,
  QuotaResetResponseSchema,
} from "../schemas/quota";
import { currentMonthUtc } from "../quota/guard";
import { clearQuotaSnapshot, getQuotaSnapshot } from "../quota/state";
import { getDb } from "../db/client";
import {
  BuildNotFoundError,
  PublishConflictError,
  computeLiveSet,
  deleteDeadStorePaths,
  finalizeBuild,
  getLatestBuild,
  getManifest,
  ingestStorePaths,
  listDeadStorePaths,
  listBuilds,
  registerRollbackRoot,
  startBuild,
} from "../db/queries";
import { narinfoKVKey } from "../storage/keys";
import { deleteText as deleteKvText } from "../storage/kv";
import { deleteObjects } from "../storage/r2";

export const apiApp = new OpenAPIHono<{ Bindings: Env }>();

// ─── write 系 route 定義 ──────────────────────────────────────────────────────

const publishStartRoute = createRoute({
  method: "post",
  path: "/api/publish/start",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: PublishStartRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: PublishStartResponseSchema } },
      description: "Build start 成功",
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
    409: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description: "build_id が published 済み",
    },
  },
});

const publishIngestRoute = createRoute({
  method: "post",
  path: "/api/publish/{buildId}/ingest",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ buildId: BuildIdSchema }),
    body: {
      content: { "application/json": { schema: PublishIngestRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: PublishIngestResponseSchema } },
      description: "ingest 成功",
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
    404: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description: "staging build 不在",
    },
    409: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description: "finalize 済みまたは差分 payload",
    },
  },
});

const publishFinalizeRoute = createRoute({
  method: "post",
  path: "/api/publish/{buildId}/finalize",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ buildId: BuildIdSchema }),
    body: {
      content: { "application/json": { schema: PublishFinalizeRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: PublishFinalizeResponseSchema } },
      description: "finalize 成功",
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
    404: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description: "staging build 不在",
    },
    409: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description: "build 状態不一致",
    },
  },
});

const rollbackRoute = createRoute({
  method: "post",
  path: "/api/hosts/{host}/rollback",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ host: HostSchema }),
    body: {
      content: { "application/json": { schema: RollbackRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: RollbackResponseSchema } },
      description: "rollback root 登録成功",
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
    404: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description: "build_id 不在",
    },
  },
});

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

const quotaResetRoute = createRoute({
  method: "post",
  path: "/api/quota/reset",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: QuotaResetResponseSchema } },
      description: "quota state reset",
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

// ─── read 系 route 定義（認証不要） ──────────────────────────────────────────

const latestBuildRoute = createRoute({
  method: "get",
  path: "/api/hosts/{host}/latest",
  request: {
    params: z.object({ host: HostSchema }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: LatestBuildResponseSchema } },
      description: "latest build",
    },
    404: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description: "published build なし",
    },
  },
});

const buildsListRoute = createRoute({
  method: "get",
  path: "/api/hosts/{host}/builds",
  request: {
    params: z.object({ host: HostSchema }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: BuildsListResponseSchema } },
      description: "build 一覧",
    },
  },
});

const manifestRoute = createRoute({
  method: "get",
  path: "/api/builds/{buildId}/manifest.json",
  request: {
    params: z.object({ buildId: BuildIdSchema }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: ManifestJsonResponseSchema } },
      description: "manifest 情報",
    },
    404: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description: "manifest なし",
    },
  },
});

const quotaStatusRoute = createRoute({
  method: "get",
  path: "/api/quota/status",
  responses: {
    200: {
      content: { "application/json": { schema: QuotaPublicStatusResponseSchema } },
      description: "quota state",
    },
  },
});

const quotaMetricsRoute = createRoute({
  method: "get",
  path: "/api/quota/metrics",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: QuotaAdminStatusResponseSchema } },
      description: "quota metrics",
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

// ─── エラーハンドリングヘルパ ─────────────────────────────────────────────────

function errorStatus(err: unknown): 400 | 404 | 409 | 500 {
  if (err instanceof PublishConflictError) return 409;
  if (err instanceof BuildNotFoundError) return 404;
  return 500;
}

/**
 * 既知エラー型は意味あるメッセージを返す。
 * それ以外（DB 例外等）は汎用 500 メッセージのみ（内部 message/スタックを body に出さない）。
 * 修正12: D1 制約名・テーブル名等の内部情報を漏らさない。
 */
function errorMessage(err: unknown): string {
  if (err instanceof PublishConflictError) return err.message;
  if (err instanceof BuildNotFoundError) return err.message;
  return "internal server error";
}

// ─── route 登録（write 系: auth middleware を適用） ───────────────────────────

apiApp.use("/api/publish/*", adminAuthMiddleware);
apiApp.use("/api/gc/*", adminAuthMiddleware);
apiApp.use("/api/quota/metrics", adminAuthMiddleware);
apiApp.use("/api/quota/reset", adminAuthMiddleware);
apiApp.use(
  "/api/hosts/:host/rollback",
  adminAuthMiddleware,
);

apiApp.openapi(publishStartRoute, async (c) => {
  const db = getDb(c.env);
  const body = c.req.valid("json");
  try {
    const { buildId } = await startBuild(db, body.build);
    return c.json({ ok: true as const, build_id: buildId }, 200);
  } catch (err) {
    const status = errorStatus(err);
    return c.json({ error: errorMessage(err) }, status as 409);
  }
});

apiApp.openapi(publishIngestRoute, async (c) => {
  const db = getDb(c.env);
  const { buildId } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    await ingestStorePaths(db, buildId, body.storePaths);
    return c.json({ ok: true as const, ingested: body.storePaths.length }, 200);
  } catch (err) {
    const status = errorStatus(err);
    return c.json({ error: errorMessage(err) }, status as 404 | 409);
  }
});

apiApp.openapi(publishFinalizeRoute, async (c) => {
  const db = getDb(c.env);
  const { buildId } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    const { publishedAt } = await finalizeBuild(db, buildId, body.manifest);
    return c.json({ ok: true as const, published_at: publishedAt }, 200);
  } catch (err) {
    const status = errorStatus(err);
    return c.json({ error: errorMessage(err) }, status as 404 | 409);
  }
});

apiApp.openapi(rollbackRoute, async (c) => {
  const db = getDb(c.env);
  const { host } = c.req.valid("param");
  const body = c.req.valid("json");
  const rollbackRootId = crypto.randomUUID();
  try {
    await registerRollbackRoot(db, {
      id: rollbackRootId,
      host,
      buildId: body.build_id,
      reason: body.reason,
      pinned: body.pinned,
      keepUntil: body.keep_until,
    });
    return c.json({ ok: true as const, rollback_root_id: rollbackRootId }, 200);
  } catch (err) {
    const status = errorStatus(err);
    return c.json({ error: errorMessage(err) }, status as 404);
  }
});

apiApp.openapi(gcDryRunRoute, async (c) => {
  const db = getDb(c.env);
  const liveSet = await computeLiveSet(db);
  return c.json({
    live_nar_keys: liveSet.liveNarKeys,
    dead_candidates: liveSet.deadCandidates,
  }, 200);
});

apiApp.openapi(gcExecuteRoute, async (c) => {
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
      (storeHash) => deleteKvText(c.env, narinfoKVKey(storeHash)),
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

apiApp.openapi(quotaResetRoute, async (c) => {
  await clearQuotaSnapshot(c.env);
  return c.json({ ok: true as const, state: "ok" as const }, 200);
});

// ─── read 系 route 登録 ───────────────────────────────────────────────────────

apiApp.openapi(latestBuildRoute, async (c) => {
  const db = getDb(c.env);
  const { host } = c.req.valid("param");
  const build = await getLatestBuild(db, host);
  if (!build) {
    return c.json({ error: "no published build found" }, 404);
  }
  return c.json({
    id: build.id,
    host: build.host,
    system: build.system,
    gitRev: build.gitRev,
    flakeLockHash: build.flakeLockHash,
    toplevelStorePath: build.toplevelStorePath,
    status: build.status,
    retentionClass: build.retentionClass,
    createdAt: build.createdAt,
    publishedAt: build.publishedAt,
  }, 200);
});

apiApp.openapi(buildsListRoute, async (c) => {
  const db = getDb(c.env);
  const { host } = c.req.valid("param");
  const builds = await listBuilds(db, host);
  return c.json({
    host,
    builds: builds.map((b) => ({
      id: b.id,
      host: b.host,
      system: b.system,
      gitRev: b.gitRev,
      flakeLockHash: b.flakeLockHash,
      toplevelStorePath: b.toplevelStorePath,
      status: b.status,
      retentionClass: b.retentionClass,
      createdAt: b.createdAt,
      publishedAt: b.publishedAt,
    })),
  }, 200);
});

apiApp.openapi(manifestRoute, async (c) => {
  const db = getDb(c.env);
  const { buildId } = c.req.valid("param");
  const manifest = await getManifest(db, buildId);
  if (!manifest) {
    return c.json({ error: "manifest not found" }, 404);
  }
  return c.json({
    buildId: manifest.buildId,
    host: manifest.host,
    system: manifest.system,
    gitRev: manifest.gitRev,
    flakeLockHash: manifest.flakeLockHash,
    toplevelStorePath: manifest.toplevelStorePath,
    closureJsonKey: manifest.closureJsonKey,
    manifestKey: manifest.manifestKey,
    manifestHash: manifest.manifestHash,
    createdAt: manifest.createdAt,
  }, 200);
});

apiApp.openapi(quotaStatusRoute, async (c) => {
  const snapshot = await getQuotaSnapshot(c.env);
  if (snapshot === null) {
    return c.json({ state: "ok" as const, checkedAt: null, month: currentMonthUtc(new Date()) }, 200);
  }
  return c.json({
    state: snapshot.state,
    checkedAt: snapshot.checkedAt,
    month: snapshot.month,
  }, 200);
});

apiApp.openapi(quotaMetricsRoute, async (c) => {
  const snapshot = await getQuotaSnapshot(c.env);
  if (snapshot === null) {
    return c.json({ state: "ok" as const, checkedAt: null, month: currentMonthUtc(new Date()) }, 200);
  }
  return c.json(snapshot, 200);
});

// ─── OpenAPI document ─────────────────────────────────────────────────────────

apiApp.doc("/api/openapi.json", {
  openapi: "3.0.0",
  info: {
    title: "cf-edgeNix Control Plane API",
    version: "0.1.0",
    description: "Nix binary cache control plane: publish, rollback, GC",
  },
});

apiApp.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  description: "ADMIN_TOKEN による Bearer 認証（write 系のみ）",
});

// ─── エラーハンドリング（hono の onError） ────────────────────────────────────

apiApp.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  if (err instanceof PublishConflictError) {
    return c.json({ error: err.message }, 409);
  }
  if (err instanceof BuildNotFoundError) {
    return c.json({ error: err.message }, 404);
  }
  return c.json({ error: "internal server error" }, 500);
});
