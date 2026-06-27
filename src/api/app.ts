import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { BuildNotFoundError, PublishConflictError } from "../db/queries";
import { buildsApp } from "./routes/builds";
import { gcApp } from "./routes/gc";
import { publishApp } from "./routes/publish";
import { quotaApp } from "./routes/quota";

export const apiApp = new OpenAPIHono<{ Bindings: Env }>();

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
