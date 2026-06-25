import { afterEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../../src/types";
import { checkReadPathAllowed, currentMonthUtc, secondsUntilMonthEnd } from "../../src/quota/guard";
import { __resetForTest, setQuotaSnapshot } from "../../src/quota/state";
import type { QuotaSnapshot } from "../../src/quota/types";

function makeEnv(value: string | null = null): Env {
  return {
    NAR_BUCKET: {} as R2Bucket,
    META_KV: {
      get: vi.fn(async () => value),
      put: vi.fn(async () => undefined),
    } as unknown as KVNamespace,
    CONTROL_DB: {} as D1Database,
  };
}

function snapshot(state: QuotaSnapshot["state"], month = "2026-06"): QuotaSnapshot {
  return {
    state,
    month,
    checkedAt: 1_719_273_600,
    metrics: {
      storageBytes: { value: 0, limit: 10, ratio: 0 },
      classAOperations: { value: 0, limit: 10, ratio: 0 },
      classBOperations: { value: 0, limit: 10, ratio: 0 },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  __resetForTest();
});

describe("checkReadPathAllowed", () => {
  test("currentMonthUtc は UTC の YYYY-MM を返す", () => {
    expect(currentMonthUtc(new Date("2026-06-30T23:59:59.000Z"))).toBe("2026-06");
    expect(currentMonthUtc(new Date("2026-07-01T00:00:00.000Z"))).toBe("2026-07");
  });

  test("snapshot null → ok", async () => {
    await expect(checkReadPathAllowed(makeEnv())).resolves.toEqual({ ok: true });
  });

  test.each(["ok", "warn"] as const)("state %s → ok", async (state) => {
    const env = makeEnv();
    await setQuotaSnapshot(env, snapshot(state));

    await expect(checkReadPathAllowed(env)).resolves.toEqual({ ok: true });
  });

  test("state killed → 503 + Retry-After + body", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T12:00:00.000Z"));
    const env = makeEnv();
    await setQuotaSnapshot(env, snapshot("killed"));

    const result = await checkReadPathAllowed(env);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected blocked");
    expect(result.response.status).toBe(503);
    expect(result.response.headers.get("Retry-After")).toBe(String(secondsUntilMonthEnd(new Date())));
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect(result.response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(result.response.headers.get("x-edgenix-quota-state")).toBe("killed");
    await expect(result.response.text()).resolves.toBe(
      "cache temporarily unavailable: monthly free-tier quota reached\n",
    );
  });

  test("前月の killed snapshot は古い状態として信用せず ok", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T12:00:00.000Z"));
    const env = makeEnv();
    await setQuotaSnapshot(env, snapshot("killed", "2026-05"));

    await expect(checkReadPathAllowed(env)).resolves.toEqual({ ok: true });
  });
});
