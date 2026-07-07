import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../../types";
import { adminAuthMiddleware } from "../middleware/auth";
import { BuildIdSchema } from "../../schemas/params";
import { ApiErrorSchema } from "../../schemas/api";
import {
  PublishFinalizeRequestSchema,
  PublishFinalizeResponseSchema,
  PublishIngestRequestSchema,
  PublishIngestResponseSchema,
  PublishStartRequestSchema,
  PublishStartResponseSchema,
} from "../../schemas/publish";
import { getDb } from "../../db/client";
import { finalizeBuild, ingestStorePaths, listClosureStoreHashes, startBuild } from "../../db/queries";
import { purgeTags, purgerFrom } from "../../cache/purge";
import { errorMessage, errorStatus } from "../helpers";

const publishApp = new OpenAPIHono<{ Bindings: Env }>();

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

publishApp.use("/api/publish/*", adminAuthMiddleware);

publishApp.openapi(publishStartRoute, async (c) => {
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

publishApp.openapi(publishIngestRoute, async (c) => {
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

publishApp.openapi(publishFinalizeRoute, async (c) => {
  const db = getDb(c.env);
  const { buildId } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    const { publishedAt } = await finalizeBuild(db, buildId, body.manifest);

    // publish 直前に引かれた narinfo は edge に 404 negative cache として残っている
    // 可能性がある。closure の narinfo タグを best-effort で purge し、公開を即時反映する
    // （purge しなくても negative cache の TTL 60 秒で自然解消する）。
    try {
      const purger = purgerFrom(c.executionCtx);
      if (purger !== null) {
        const storeHashes = await listClosureStoreHashes(db, buildId);
        c.executionCtx.waitUntil(
          purgeTags(purger, storeHashes.map((h) => `narinfo:${h}`)),
        );
      }
    } catch {
      // executionCtx 不在（テスト等）は purge 非対応として扱う
    }

    return c.json({ ok: true as const, published_at: publishedAt }, 200);
  } catch (err) {
    const status = errorStatus(err);
    return c.json({ error: errorMessage(err) }, status as 404 | 409);
  }
});

export { publishApp };
