import { afterEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../../src/types";
import { __resetForTest, clearQuotaSnapshot, getQuotaSnapshot, setQuotaSnapshot } from "../../src/quota/state";
import type { QuotaSnapshot } from "../../src/quota/types";
import { QUOTA_EPOCH_KV_KEY, QUOTA_STATE_KV_KEY } from "../../src/storage/keys";

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

function makeEnv(value: string | null, epoch = 0): { env: Env; get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> } {
  const kvStore = new Map<string, string>();
  if (value !== null) kvStore.set(QUOTA_STATE_KV_KEY, value);
  kvStore.set(QUOTA_EPOCH_KV_KEY, String(epoch));

  const get = vi.fn(async (key: string) => kvStore.get(key) ?? null);
  const put = vi.fn(async (key: string, val: string) => { kvStore.set(key, val); });
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
  vi.restoreAllMocks();
  __resetForTest();
});

describe("quota state", () => {
  test("epoch 一致時は L0 ヒットで snapshot KV 読み取りを抑制", async () => {
    const expected = snapshot();
    const { env, get } = makeEnv(JSON.stringify(expected));

    await expect(getQuotaSnapshot(env)).resolves.toEqual(expected);
    await expect(getQuotaSnapshot(env)).resolves.toEqual(expected);

    const snapshotReads = get.mock.calls.filter((args) => args[0] === QUOTA_STATE_KV_KEY);
    expect(snapshotReads).toHaveLength(1);
  });

  test("setQuotaSnapshot 後の getQuotaSnapshot が同一値を返す", async () => {
    const expected = snapshot();
    const { env, put } = makeEnv(null);

    await setQuotaSnapshot(env, expected);
    await expect(getQuotaSnapshot(env)).resolves.toEqual(expected);

    expect(put).toHaveBeenCalledWith(QUOTA_STATE_KV_KEY, JSON.stringify(expected));
    expect(put).toHaveBeenCalledWith(QUOTA_EPOCH_KV_KEY, expect.any(String));
  });

  test("setQuotaSnapshot が epoch をインクリメントする", async () => {
    const { env, put } = makeEnv(null, 5);

    await setQuotaSnapshot(env, snapshot());

    expect(put).toHaveBeenCalledWith(QUOTA_EPOCH_KV_KEY, "6");
  });

  test("epoch 変化時に L0 を破棄して KV から再取得する", async () => {
    const v1 = snapshot();
    const { env, get } = makeEnv(JSON.stringify(v1), 1);

    await expect(getQuotaSnapshot(env)).resolves.toEqual(v1);

    const v2: QuotaSnapshot = { ...v1, state: "ok" };
    const kvStore = new Map<string, string>();
    kvStore.set(QUOTA_STATE_KV_KEY, JSON.stringify(v2));
    kvStore.set(QUOTA_EPOCH_KV_KEY, "2");
    get.mockImplementation(async (key: string) => kvStore.get(key) ?? null);

    await expect(getQuotaSnapshot(env)).resolves.toEqual(v2);

    const snapshotReads = get.mock.calls.filter((args) => args[0] === QUOTA_STATE_KV_KEY);
    expect(snapshotReads).toHaveLength(2);
  });

  test("不正 JSON 文字列は null を返し L0 に入れない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env, get } = makeEnv("{");

    await expect(getQuotaSnapshot(env)).resolves.toBeNull();
    await expect(getQuotaSnapshot(env)).resolves.toBeNull();

    const snapshotReads = get.mock.calls.filter((args) => args[0] === QUOTA_STATE_KV_KEY);
    expect(snapshotReads).toHaveLength(2);
    expect(warn).toHaveBeenCalled();
  });

  test("型不一致の snapshot は null を返し L0 に入れない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env, get } = makeEnv(JSON.stringify({ ...snapshot(), state: "foo" }));

    await expect(getQuotaSnapshot(env)).resolves.toBeNull();
    await expect(getQuotaSnapshot(env)).resolves.toBeNull();

    const snapshotReads = get.mock.calls.filter((args) => args[0] === QUOTA_STATE_KV_KEY);
    expect(snapshotReads).toHaveLength(2);
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

  test("setQuotaSnapshot は state を epoch より先に書く", async () => {
    const writeOrder: string[] = [];
    const kvStore = new Map<string, string>();
    kvStore.set(QUOTA_EPOCH_KV_KEY, "0");
    const env: Env = {
      NAR_BUCKET: {} as R2Bucket,
      META_KV: {
        get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
        put: vi.fn(async (key: string, val: string) => {
          writeOrder.push(key);
          kvStore.set(key, val);
        }),
      } as unknown as KVNamespace,
      CONTROL_DB: {} as D1Database,
    };

    await setQuotaSnapshot(env, snapshot());

    expect(writeOrder).toEqual([QUOTA_STATE_KV_KEY, QUOTA_EPOCH_KV_KEY]);
  });

  test("clearQuotaSnapshot が epoch をインクリメントする", async () => {
    const { env, put } = makeEnv(null, 3);

    await clearQuotaSnapshot(env);

    expect(put).toHaveBeenCalledWith(QUOTA_EPOCH_KV_KEY, "4");
    expect(put).toHaveBeenCalledWith(QUOTA_STATE_KV_KEY, expect.any(String));
  });

  test("KV に epoch が存在しない場合は 0 として扱い正常動作する", async () => {
    const expected = snapshot();
    const kvStore = new Map<string, string>();
    kvStore.set(QUOTA_STATE_KV_KEY, JSON.stringify(expected));

    const env: Env = {
      NAR_BUCKET: {} as R2Bucket,
      META_KV: {
        get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
        put: vi.fn(async (key: string, val: string) => { kvStore.set(key, val); }),
      } as unknown as KVNamespace,
      CONTROL_DB: {} as D1Database,
    };

    await expect(getQuotaSnapshot(env)).resolves.toEqual(expected);
  });

  test("epoch が不正値の場合は 0 にフォールバックする", async () => {
    const expected = snapshot();
    const kvStore = new Map<string, string>();
    kvStore.set(QUOTA_STATE_KV_KEY, JSON.stringify(expected));
    kvStore.set(QUOTA_EPOCH_KV_KEY, "not-a-number");

    const env: Env = {
      NAR_BUCKET: {} as R2Bucket,
      META_KV: {
        get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
        put: vi.fn(async (key: string, val: string) => { kvStore.set(key, val); }),
      } as unknown as KVNamespace,
      CONTROL_DB: {} as D1Database,
    };

    await expect(getQuotaSnapshot(env)).resolves.toEqual(expected);
  });
});
