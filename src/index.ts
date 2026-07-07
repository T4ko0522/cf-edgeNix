import type { Env } from "./types";
import { route } from "./router";
import { handleCacheInfo } from "./handlers/cacheInfo";
import { handleNarinfo } from "./handlers/narinfo";
import { handleNar } from "./handlers/nar";
import { apiApp } from "./api/app";
import { checkReadPathAllowed } from "./quota/guard";
import { runQuotaCheck } from "./quota/cron";

/**
 * cf-edgeNix Worker entry。
 *
 * read path（narinfo / nix-cache-info）は memory → KV → R2 で完結し D1 を挟まない。
 * NAR 本体は Worker 経由で Cache API → R2 streaming。
 * 管理系（/api/...）は hono OpenAPIHono アプリへ委譲し D1 を参照する。
 * 詳細は docs/spec.md §10。
 */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // /api/* は hono へ全委譲（受入 F2 のとおり read path は既存のまま）
    if (url.pathname.startsWith("/api/")) {
      return apiApp.fetch(req, env, ctx);
    }

    const r = route(url.pathname);
    if (r.kind !== "not-found") {
      const allowed = await checkReadPathAllowed(env);
      if (!allowed.ok) return allowed.response;
    }

    switch (r.kind) {
      case "cache-info":
        if (!isReadMethod(req)) return methodNotAllowed();
        return handleCacheInfo(env);

      case "narinfo":
        if (!isReadMethod(req)) return methodNotAllowed();
        return handleNarinfo(env, r.storeHash);

      case "nar":
        if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed();
        return handleNar(req, env, r.fileName);

      case "not-found":
        return new Response("not found\n", { status: 404 });
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) {
      console.warn("[quota] CF_ACCOUNT_ID or CF_ANALYTICS_TOKEN not set; skipping check");
      return;
    }
    await runQuotaCheck(env, ctx, new Date());
  },
} satisfies ExportedHandler<Env>;

function isReadMethod(req: Request): boolean {
  return req.method === "GET" || req.method === "HEAD";
}

function methodNotAllowed(): Response {
  return new Response("method not allowed\n", { status: 405 });
}
