import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../../src/types";
import { fetchR2Usage } from "../../src/quota/analytics";
import { runQuotaCheck } from "../../src/quota/cron";
import { __resetForTest } from "../../src/quota/state";
import type { QuotaSnapshot } from "../../src/quota/types";

vi.mock("../../src/quota/analytics", () => ({
  fetchR2Usage: vi.fn(),
}));

const fetchR2UsageMock = vi.mocked(fetchR2Usage);

function snapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    state: "warn",
    month: "2026-06",
    checkedAt: 1_719_273_600,
    metrics: {
      storageBytes: { value: 8, limit: 10, ratio: 0.8 },
      classAOperations: { value: 0, limit: 10, ratio: 0 },
      classBOperations: { value: 0, limit: 10, ratio: 0 },
    },
    ...overrides,
  };
}

function makeEnv(initial: QuotaSnapshot | null): {
  env: Env;
  put: ReturnType<typeof vi.fn>;
  stored: () => QuotaSnapshot | null;
} {
  let value = initial === null ? null : JSON.stringify(initial);
  const put = vi.fn(async (_key: string, next: string) => {
    value = next;
  });
  return {
    env: {
      NAR_BUCKET: {} as R2Bucket,
      META_KV: {
        get: vi.fn(async () => value),
        put,
      } as unknown as KVNamespace,
      CONTROL_DB: {} as D1Database,
    },
    put,
    stored: () => value === null ? null : JSON.parse(value) as QuotaSnapshot,
  };
}

beforeEach(() => {
  fetchR2UsageMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetForTest();
});

describe("runQuotaCheck", () => {
  test("fetch 連続失敗時に既存 snapshot のカウンタが増える", async () => {
    fetchR2UsageMock.mockRejectedValue(new Error("network"));
    const { env, stored } = makeEnv(snapshot({ consecutiveFetchFailures: 1 }));

    await runQuotaCheck(env, {} as ExecutionContext, new Date("2026-06-25T12:00:00.000Z"));

    expect(stored()?.consecutiveFetchFailures).toBe(2);
    expect(stored()?.state).toBe("warn");
    expect(stored()?.metrics.storageBytes.value).toBe(8);
  });

  test("成功時にカウンタが 0 にリセットされる", async () => {
    fetchR2UsageMock.mockResolvedValue({
      storageBytes: 0,
      classAOperations: 0,
      classBOperations: 0,
    });
    const { env, stored } = makeEnv(snapshot({ consecutiveFetchFailures: 2 }));

    await runQuotaCheck(env, {} as ExecutionContext, new Date("2026-06-25T12:00:00.000Z"));

    expect(stored()?.state).toBe("ok");
    expect(stored()?.month).toBe("2026-06");
    expect(stored()?.consecutiveFetchFailures).toBe(0);
  });

  test("3 回目の連続失敗で警告を出す", async () => {
    fetchR2UsageMock.mockRejectedValue(new Error("network"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env } = makeEnv(snapshot({ consecutiveFetchFailures: 2 }));

    await runQuotaCheck(env, {} as ExecutionContext, new Date("2026-06-25T12:00:00.000Z"));

    expect(warn).toHaveBeenCalledWith(
      "[quota] analytics has failed",
      3,
      "times consecutively",
    );
  });

  test("既存 snapshot がない状態で失敗した場合は新規 snapshot を作らない", async () => {
    fetchR2UsageMock.mockRejectedValue(new Error("network"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env, put, stored } = makeEnv(null);

    await runQuotaCheck(env, {} as ExecutionContext, new Date("2026-06-25T12:00:00.000Z"));

    expect(stored()).toBeNull();
    expect(put).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[quota] analytics fetch failed:", expect.any(Error));
  });
});
