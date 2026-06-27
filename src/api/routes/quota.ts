import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { Env } from "../../types";
import { adminAuthMiddleware } from "../middleware/auth";
import { ApiErrorSchema } from "../../schemas/api";
import {
  QuotaAdminStatusResponseSchema,
  QuotaPublicStatusResponseSchema,
  QuotaResetResponseSchema,
} from "../../schemas/quota";
import { currentMonthUtc } from "../../quota/guard";
import { clearQuotaSnapshot, getQuotaSnapshot } from "../../quota/state";

const quotaApp = new OpenAPIHono<{ Bindings: Env }>();

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

quotaApp.use("/api/quota/metrics", adminAuthMiddleware);
quotaApp.use("/api/quota/reset", adminAuthMiddleware);

quotaApp.openapi(quotaResetRoute, async (c) => {
  await clearQuotaSnapshot(c.env);
  return c.json({ ok: true as const, state: "ok" as const }, 200);
});

quotaApp.openapi(quotaStatusRoute, async (c) => {
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

quotaApp.openapi(quotaMetricsRoute, async (c) => {
  const snapshot = await getQuotaSnapshot(c.env);
  if (snapshot === null) {
    return c.json({ state: "ok" as const, checkedAt: null, month: currentMonthUtc(new Date()) }, 200);
  }
  return c.json(snapshot, 200);
});

export { quotaApp };
