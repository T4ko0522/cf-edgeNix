import { afterEach, describe, expect, test, vi } from "vitest";
import worker from "../../src/index";
import { __resetForTest } from "../../src/quota/state";
import type { Env } from "../../src/types";
import { QUOTA_EPOCH_KV_KEY, QUOTA_STATE_KV_KEY } from "../../src/storage/keys";

function makeKilledEnv(): Env {
  const killedSnapshot = {
    state: "killed",
    month: "2026-06",
    checkedAt: 1_719_273_600,
    metrics: {
      storageBytes: { value: 9_500_000_000, limit: 10_000_000_000, ratio: 0.95 },
      classAOperations: { value: 0, limit: 1_000_000, ratio: 0 },
      classBOperations: { value: 0, limit: 10_000_000, ratio: 0 },
    },
  };
  const kvStore = new Map<string, string>();
  kvStore.set(QUOTA_STATE_KV_KEY, JSON.stringify(killedSnapshot));
  kvStore.set(QUOTA_EPOCH_KV_KEY, "1");

  return {
    NAR_BUCKET: {} as R2Bucket,
    META_KV: {
      get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
    } as unknown as KVNamespace,
    CONTROL_DB: {} as D1Database,
  };
}

afterEach(() => {
  vi.useRealTimers();
  __resetForTest();
});

describe("Worker read path quota guard", () => {
  test("not-found には quota guard を適用しない", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T12:00:00.000Z"));
    const env = makeKilledEnv();

    const res = await worker.fetch(
      new Request("https://example.com/no-such-path"),
      env,
      {} as ExecutionContext,
    );

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found\n");
    expect(env.META_KV.get).not.toHaveBeenCalled();
  });
});
