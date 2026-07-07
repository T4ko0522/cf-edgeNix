import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { BuildNotFoundError, PublishConflictError } from "../db/queries";
import { buildsApp } from "./routes/builds";
import { gcApp } from "./routes/gc";
import { publishApp } from "./routes/publish";
import { quotaApp } from "./routes/quota";

export const apiApp = new OpenAPIHono<{ Bindings: Env }>();

// Workers Cache（wrangler.toml [cache]）は Cache-Control のない 200 を
// ヒューリスティックで最大 2 時間キャッシュする。/api/* は latest pointer など
// 鮮度が意味を持つ control plane なので、全応答を no-store で edge キャッシュ対象外にする。
apiApp.use("*", async (c, next) => {
  await next();
  c.res.headers.set("cache-control", "no-store");
});

apiApp.route("/", publishApp);
apiApp.route("/", gcApp);
apiApp.route("/", buildsApp);
apiApp.route("/", quotaApp);

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

apiApp.onError((err, c) => {
  // onError は middleware の post 処理（no-store 付与）を通らないため、ここでも明示する。
  c.header("cache-control", "no-store");
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
