import { describe, expect, test, vi } from "vitest";
import type { Env } from "../../src/types";
import { runScheduledGc } from "../../src/gc/cron";

function env(adminToken?: string): Env {
  return {
    NAR_BUCKET: {} as R2Bucket,
    META_KV: {} as KVNamespace,
    CONTROL_DB: {} as D1Database,
    ADMIN_TOKEN: adminToken,
  };
}

describe("runScheduledGc", () => {
  test("grace済みNARを先に削除してから新しいnarinfoを非公開化する", async () => {
    const phases: string[] = [];
    const internalFetch = vi.fn(async (request: Request) => {
      expect(request.headers.get("authorization")).toBe("Bearer secret");
      phases.push((await request.json() as { phase: string }).phase);
      return Response.json({ ok: true, processed: 1, dead_remaining: 0 });
    });

    await runScheduledGc(env("secret"), {} as ExecutionContext, internalFetch);

    expect(phases).toEqual(["nar", "narinfo"]);
  });

  test("ADMIN_TOKEN未設定ならGCを実行しない", async () => {
    const internalFetch = vi.fn();
    await runScheduledGc(env(), {} as ExecutionContext, internalFetch);
    expect(internalFetch).not.toHaveBeenCalled();
  });

  test("GC APIの失敗をscheduled handlerへ伝播する", async () => {
    const internalFetch = vi.fn(async () => new Response("failed", { status: 500 }));
    await expect(runScheduledGc(env("secret"), {} as ExecutionContext, internalFetch))
      .rejects.toThrow("scheduled GC nar failed: 500");
  });
});
