import type { MiddlewareHandler } from "hono";
import { checkAdminAuth } from "../../auth";
import type { Env } from "../../types";

/**
 * write 系エンドポイント用 Bearer 認証 middleware。
 * ADMIN_TOKEN 未設定 → 403、トークン不一致 → 401。
 * read 系には適用しない（受入 B2）。
 */
export const adminAuthMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const result = checkAdminAuth(c.req.raw, c.env.ADMIN_TOKEN);
  if (!result.ok) {
    return c.json({ error: "unauthorized" }, result.status);
  }
  await next();
};
