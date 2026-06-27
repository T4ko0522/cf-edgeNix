import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../../types";
import { adminAuthMiddleware } from "../middleware/auth";
import {
  BuildIdSchema,
  HostSchema,
} from "../../schemas/params";
import {
  ApiErrorSchema,
  BuildsListResponseSchema,
  LatestBuildResponseSchema,
  ManifestJsonResponseSchema,
  PatchBuildRequestSchema,
  PatchBuildResponseSchema,
  RollbackRequestSchema,
  RollbackResponseSchema,
} from "../../schemas/api";
import { getDb } from "../../db/client";
import {
  getLatestBuild,
  getManifest,
  listBuilds,
  pinBuild,
  registerRollbackRoot,
  unpinBuild,
} from "../../db/queries";
import { errorMessage, errorStatus } from "../helpers";

const buildsApp = new OpenAPIHono<{ Bindings: Env }>();

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

const patchBuildRoute = createRoute({
  method: "patch",
  path: "/api/builds/{buildId}",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ buildId: BuildIdSchema }),
    body: {
      content: { "application/json": { schema: PatchBuildRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: PatchBuildResponseSchema } },
      description: "build pin 状態更新成功",
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
    500: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description: "サーバ内部エラー",
    },
  },
});

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

buildsApp.use("/api/builds/:buildId", adminAuthMiddleware);
buildsApp.use(
  "/api/hosts/:host/rollback",
  adminAuthMiddleware,
);

buildsApp.openapi(rollbackRoute, async (c) => {
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

buildsApp.openapi(patchBuildRoute, async (c) => {
  const db = getDb(c.env);
  const { buildId } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    if (body.pinned) {
      await pinBuild(db, buildId, body.reason);
    } else {
      await unpinBuild(db, buildId);
    }
    return c.json({ ok: true as const, build_id: buildId, pinned: body.pinned }, 200);
  } catch (err) {
    const status = errorStatus(err);
    return c.json({ error: errorMessage(err) }, status as 404 | 500);
  }
});

buildsApp.openapi(latestBuildRoute, async (c) => {
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

buildsApp.openapi(buildsListRoute, async (c) => {
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

buildsApp.openapi(manifestRoute, async (c) => {
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

export { buildsApp };
