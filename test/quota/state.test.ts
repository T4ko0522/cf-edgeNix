import { afterEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../../src/types";
import { __resetForTest, getQuotaSnapshot, setQuotaSnapshot } from "../../src/quota/state";
import type { QuotaSnapshot } from "../../src/quota/types";

function snapshot(): QuotaSnapshot {
  return {
    state: "warn",
    month: "2026-06",
    checkedAt: 1_719_273_600,
    metrics: {
      storageBytes: { value: 8, limit: 10, ratio: 0.8 },
      classAOperations: { value: 0, limit: 10, ratio: 0 },
      classBOperations: { value: 0, limit: 10, ratio: 0 },
    },
  };
}

function makeEnv(value: string | null): { env: Env; get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> } {
  const get = vi.fn(async () => value);
  const put = vi.fn(async () => undefined);
  return {
    env: {
      NAR_BUCKET: {} as R2Bucket,
      META_KV: { get, put } as unknown as KVNamespace,
      CONTROL_DB: {} as D1Database,
    },
    get,
    put,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  __resetForTest();
});

describe("quota state", () => {
  test("memory L0 が KV 呼び出しを抑制", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T00:00:00.000Z"));
    const expected = snapshot();
    const { env, get } = makeEnv(JSON.stringify(expected));

    await expect(getQuotaSnapshot(env)).resolves.toEqual(expected);
    await expect(getQuotaSnapshot(env)).resolves.toEqual(expected);

    expect(get).toHaveBeenCalledTimes(1);
  });

  test("setQuotaSnapshot 後の getQuotaSnapshot が同一値を返す", async () => {
    const expected = snapshot();
    const { env, put } = makeEnv(null);

    await setQuotaSnapshot(env, expected);
    await expect(getQuotaSnapshot(env)).resolves.toEqual(expected);

    expect(put).toHaveBeenCalledWith("quota:state", JSON.stringify(expected));
  });

  test("不正 JSON 文字列は null を返し L0 に入れない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env, get } = makeEnv("{");

    await expect(getQuotaSnapshot(env)).resolves.toBeNull();
    await expect(getQuotaSnapshot(env)).resolves.toBeNull();

    expect(get).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
  });

  test("型不一致の snapshot は null を返し L0 に入れない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env, get } = makeEnv(JSON.stringify({ ...snapshot(), state: "foo" }));

    await expect(getQuotaSnapshot(env)).resolves.toBeNull();
    await expect(getQuotaSnapshot(env)).resolves.toBeNull();

    expect(get).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "[quota] snapshot schema validation failed:",
      expect.anything(),
    );
  });

  test("前月 snapshot は state 層では正常値として返す", async () => {
    const expected = { ...snapshot(), month: "2026-05" };
    const { env } = makeEnv(JSON.stringify(expected));

    await expect(getQuotaSnapshot(env)).resolves.toEqual(expected);
  });
});
