import type { Env } from "../types";
import { apiApp } from "../api/app";

type InternalFetch = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Promise<Response>;

const defaultInternalFetch: InternalFetch = async (request, env, ctx) =>
  apiApp.fetch(request, env, ctx);

/**
 * 前回までにgraceを満たしたNARを削除してから、新しいdead narinfoを非公開化する。
 * 各phaseはAPI上限の10件に留め、hourly cronごとの処理量を予測可能にする。
 */
export async function runScheduledGc(
  env: Env,
  ctx: ExecutionContext,
  internalFetch: InternalFetch = defaultInternalFetch,
): Promise<void> {
  if (!env.ADMIN_TOKEN) {
    console.warn("[gc] ADMIN_TOKEN not set; skipping scheduled GC");
    return;
  }

  for (const phase of ["nar", "narinfo"] as const) {
    const response = await internalFetch(
      new Request("https://internal.cf-edgenix/api/gc/execute", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ phase, max_deletes: 10 }),
      }),
      env,
      ctx,
    );
    if (!response.ok) {
      throw new Error(`scheduled GC ${phase} failed: ${response.status}`);
    }
    const result = await response.json() as {
      processed?: number;
      dead_remaining?: number;
    };
    console.log(
      `[gc] phase=${phase} processed=${result.processed ?? 0} remaining=${result.dead_remaining ?? 0}`,
    );
  }
}
