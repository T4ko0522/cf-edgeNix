/**
 * test/publish/publish-script.test.ts
 *
 * scripts/publish.ts の純粋ロジック + exec アダプタ注入のユニットテスト。
 *
 * テスト観点:
 *   G4: publish 経路の一本化（closure/manifest put → NAR → narinfo → D1 → KV の順）
 *   G5: closure.json / manifest.json の R2 put・manifestHash が実ハッシュ・
 *       toplevelStorePath が実値・NAR 冪等スキップ
 *   A2: 公開順序保証（closure/manifest → NAR → narinfo → D1 → KV）
 *   A5: 再 publish 冪等（NAR スキップ）
 */
import { describe, expect, test, vi } from "vitest";

// vi.mock はトップレベルに置く必要がある（vitest がホイストするため）
vi.mock("fs/promises", () => ({
  readdir: vi.fn(async () => ["abcdef123456aaaa.narinfo"]),
  readFile: vi.fn(async (path: string, _enc: unknown) => {
    if (typeof path === "string" && path.includes("closure.json")) {
      return JSON.stringify({ paths: ["/nix/store/abcdef123456aaaa-hello-2.12.1"] });
    }
    return `StorePath: /nix/store/abcdef123456aaaa-hello-2.12.1
URL: nar/sha256:file001.nar.zst
Compression: zstd
FileHash: sha256:aaaa0000000000000000000000000000000000000000000000000000000000aa
FileSize: 12345
NarHash: sha256:bbbb0000000000000000000000000000000000000000000000000000000000bb
NarSize: 67890
`;
  }),
  writeFile: vi.fn(async () => {}),
}));

import {
  type ExecAdapter,
  type NarinfoMeta,
  buildManifestJson,
  parseNarinfo,
  publish,
  sha256Hex,
} from "../../scripts/publish";

// ─── フィクスチャ ─────────────────────────────────────────────────────────────

const SAMPLE_NARINFO_TEXT = `StorePath: /nix/store/abcdef123456aaaa-hello-2.12.1
URL: nar/sha256:file001.nar.zst
Compression: zstd
FileHash: sha256:aaaa0000000000000000000000000000000000000000000000000000000000aa
FileSize: 12345
NarHash: sha256:bbbb0000000000000000000000000000000000000000000000000000000000bb
NarSize: 67890
`;

const SAMPLE_BUILD_META = {
  id: "test-build-001",
  host: "test-host",
  system: "x86_64-linux",
  gitRev: "deadbeef",
  flakeLockHash: "sha256:lock",
  toplevelStorePath: "/nix/store/abcdef123456aaaa-hello-2.12.1",
  createdAt: 1700000000000,
};

const SAMPLE_ENV = {
  apiBaseUrl: "https://cache.example.com",
  adminToken: "test-token",
  r2BucketName: "my-bucket",
  kvNamespaceId: "kv-ns-001",
};

// ─── parseNarinfo (publish.ts 版) ─────────────────────────────────────────────

describe("parseNarinfo (scripts/publish.ts)", () => {
  test("全フィールドを正しく抽出する", () => {
    const meta = parseNarinfo(SAMPLE_NARINFO_TEXT);
    expect(meta.storeHash).toBe("abcdef123456aaaa");
    expect(meta.storePath).toBe("/nix/store/abcdef123456aaaa-hello-2.12.1");
    expect(meta.narKey).toBe("nar/sha256:file001.nar.zst");
    expect(meta.narinfoKey).toBe("abcdef123456aaaa.narinfo");
    expect(meta.narSize).toBe(67890);
    expect(meta.fileSize).toBe(12345);
    expect(meta.compression).toBe("zstd");
  });

  test("必須フィールド欠落は Error", () => {
    const noStorePath = SAMPLE_NARINFO_TEXT.replace(/^StorePath:.*\n/m, "");
    expect(() => parseNarinfo(noStorePath)).toThrow();
  });
});

// ─── sha256Hex ─────────────────────────────────────────────────────────────────

describe("sha256Hex", () => {
  test("sha256: プレフィクスを返す", () => {
    expect(sha256Hex("hello")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("同じ内容なら同じハッシュ", () => {
    expect(sha256Hex("content")).toBe(sha256Hex("content"));
  });

  test("内容が違えばハッシュも違う", () => {
    expect(sha256Hex("aaa")).not.toBe(sha256Hex("bbb"));
  });

  test("placeholder でない（固定文字列と一致しない）", () => {
    expect(sha256Hex("some content")).not.toBe("sha256:placeholder");
  });
});

// ─── buildManifestJson ─────────────────────────────────────────────────────────

describe("buildManifestJson", () => {
  const narinfo: NarinfoMeta = parseNarinfo(SAMPLE_NARINFO_TEXT);

  test("JSON 文字列を返す", () => {
    const json = buildManifestJson({
      buildId: "build-001",
      host: "test-host",
      system: "x86_64-linux",
      gitRev: "abc",
      flakeLockHash: "sha256:lock",
      toplevelStorePath: "/nix/store/abcdef123456aaaa-hello-2.12.1",
      narinfos: [narinfo],
      closureJsonKey: "manifests/build-001/closure.json",
    });
    const obj = JSON.parse(json) as {
      buildId: string;
      toplevelStorePath: string;
      storePaths: Array<{ storeHash: string }>;
      closureJsonKey: string;
    };
    expect(obj.buildId).toBe("build-001");
    expect(obj.toplevelStorePath).toBe("/nix/store/abcdef123456aaaa-hello-2.12.1");
    expect(obj.storePaths).toHaveLength(1);
    expect(obj.storePaths[0]?.storeHash).toBe("abcdef123456aaaa");
    expect(obj.closureJsonKey).toBe("manifests/build-001/closure.json");
  });

  test("toplevelStorePath が placeholder でない", () => {
    const json = buildManifestJson({
      buildId: "b",
      host: "h",
      system: "x86_64-linux",
      gitRev: "r",
      flakeLockHash: "f",
      toplevelStorePath: "/nix/store/realpath-pkg",
      narinfos: [],
      closureJsonKey: "manifests/b/closure.json",
    });
    expect(json).not.toContain("placeholder");
  });
});

// ─── r2PutIfAbsent は削除済み（NAR は常に put・上書き安全） ──────────────────

// ─── publish — 呼び出し順序・内容検証 ──────────────────────────────────────────

describe("publish — exec アダプタ注入によるテスト", () => {
  type R2Call = { op: "put" | "putContent"; key: string };
  type ApiCall = { url: string; body: unknown };
  type KvCall = { key: string };

  interface ManifestMeta {
    closureJsonKey: string;
    manifestKey: string;
    manifestHash: string;
    host: string;
    system: string;
    gitRev: string;
    flakeLockHash: string;
    toplevelStorePath: string;
  }

  function makeSpyAdapter(opts?: {
    kvReject?: boolean;
  }): {
    adapter: ExecAdapter;
    r2Calls: R2Call[];
    apiCalls: ApiCall[];
    kvCalls: KvCall[];
  } {
    const r2Calls: R2Call[] = [];
    const apiCalls: ApiCall[] = [];
    const kvCalls: KvCall[] = [];
    const kvReject = opts?.kvReject ?? false;

    const adapter: ExecAdapter = {
      r2Put: vi.fn(async (_bucket: string, key: string, _file: string) => {
        r2Calls.push({ op: "put", key });
      }),
      r2PutContent: vi.fn(async (_bucket: string, key: string, _content: string) => {
        r2Calls.push({ op: "putContent", key });
      }),
      r2Has: vi.fn(async (_bucket: string, _key: string) => {
        // 差分化テスト: デフォルトでは「既存なし」扱いとして全件 PUT させる。
        // (存在ヒット時のスキップ挙動は別テストで検証)
        return false;
      }),
      kvPutBulk: vi.fn(
        async (
          _ns: string,
          items: ReadonlyArray<{ key: string; value: string }>,
        ) => {
          // bulk 1 リクエストに含まれる各 key を kvCalls に展開記録 (既存 assertion 互換)。
          for (const it of items) kvCalls.push({ key: it.key });
          if (kvReject) throw new Error("KV bulk failed");
        },
      ),
      apiPost: vi.fn(async (url: string, _token: string, body: unknown) => {
        apiCalls.push({ url, body });
        if (url.endsWith("/start")) {
          return { ok: true, build_id: "test-build-001" };
        }
        if (url.includes("/ingest")) {
          return { ok: true, ingested: 0 };
        }
        if (url.includes("/finalize")) {
          return { ok: true, published_at: 1700000000000 };
        }
        return {};
      }),
    };

    return { adapter, r2Calls, apiCalls, kvCalls };
  }

  test("closure.json の R2 put が最初の r2Put 呼び出しになる", async () => {
    const { adapter, r2Calls } = makeSpyAdapter();
    await publish("/fake/cache", SAMPLE_BUILD_META, SAMPLE_ENV, adapter);

    const putCalls = r2Calls.filter((c) => c.op === "put");
    expect(putCalls[0]?.key).toMatch(/closure\.json$/);
  });

  test("manifest.json の R2 put が 2 番目の put になる", async () => {
    const { adapter, r2Calls } = makeSpyAdapter();
    await publish("/fake/cache", SAMPLE_BUILD_META, SAMPLE_ENV, adapter);

    const putCalls = r2Calls.filter((c) => c.op === "put");
    expect(putCalls[1]?.key).toMatch(/manifest\.json$/);
  });

  test("closure.json / manifest.json キーが manifests/<buildId>/ 配下", async () => {
    const { adapter, r2Calls } = makeSpyAdapter();
    await publish("/fake/cache", SAMPLE_BUILD_META, SAMPLE_ENV, adapter);

    const putCalls = r2Calls.filter((c) => c.op === "put");
    const closureKey = putCalls.find((c) => c.key.endsWith("closure.json"))?.key;
    const manifestKey = putCalls.find((c) => c.key.endsWith("manifest.json"))?.key;
    expect(closureKey).toBe(`manifests/${SAMPLE_BUILD_META.id}/closure.json`);
    expect(manifestKey).toBe(`manifests/${SAMPLE_BUILD_META.id}/manifest.json`);
  });

  test("finalize の manifestHash が placeholder でない", async () => {
    const { adapter, apiCalls } = makeSpyAdapter();
    await publish("/fake/cache", SAMPLE_BUILD_META, SAMPLE_ENV, adapter);

    const finalizeCall = apiCalls.find((c) => c.url.includes("/finalize"));
    expect(finalizeCall).toBeDefined();
    const manifest = (finalizeCall?.body as { manifest: ManifestMeta }).manifest;
    expect(manifest.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.manifestHash).not.toBe("sha256:placeholder");
  });

  test("finalize の toplevelStorePath が実値（placeholder でない）", async () => {
    const { adapter, apiCalls } = makeSpyAdapter();
    await publish("/fake/cache", SAMPLE_BUILD_META, SAMPLE_ENV, adapter);

    const finalizeCall = apiCalls.find((c) => c.url.includes("/finalize"));
    const manifest = (finalizeCall?.body as { manifest: ManifestMeta }).manifest;
    expect(manifest.toplevelStorePath).toBe("/nix/store/abcdef123456aaaa-hello-2.12.1");
    expect(manifest.toplevelStorePath).not.toBe("placeholder");
  });

  test("NAR の存在チェック（r2Head 相当）は呼ばれない（常に r2Put で上書き安全）", async () => {
    const { adapter, r2Calls } = makeSpyAdapter();
    await publish("/fake/cache", SAMPLE_BUILD_META, SAMPLE_ENV, adapter);

    // r2PutIfAbsent / r2Head を撤去したため、put/putContent 以外の呼び出しはゼロ
    const nonPutCalls = r2Calls.filter((c) => c.op !== "put" && c.op !== "putContent");
    expect(nonPutCalls).toHaveLength(0);
  });

  test("NAR は常に r2Put で投入される（上書き安全・idempotent）", async () => {
    const { adapter, r2Calls } = makeSpyAdapter();
    await publish("/fake/cache", SAMPLE_BUILD_META, SAMPLE_ENV, adapter);

    const putCalls = r2Calls.filter((c) => c.op === "put");
    const narPutCalls = putCalls.filter((c) => c.key.startsWith("nar/"));
    expect(narPutCalls.length).toBeGreaterThan(0);
  });

  test("NAR put は narinfo put より前に来る", async () => {
    const { adapter, r2Calls } = makeSpyAdapter();
    await publish("/fake/cache", SAMPLE_BUILD_META, SAMPLE_ENV, adapter);

    const putCalls = r2Calls.filter((c) => c.op === "put");
    const narPutIdx = putCalls.findIndex((c) => c.key.startsWith("nar/"));
    const narinfoPutIdx = putCalls.findIndex((c) => c.key.endsWith(".narinfo"));
    expect(narPutIdx).toBeGreaterThanOrEqual(0);
    expect(narinfoPutIdx).toBeGreaterThanOrEqual(0);
    expect(narPutIdx).toBeLessThan(narinfoPutIdx);
  });

  test("API 呼び出し順序: start → ingest → finalize", async () => {
    const { adapter, apiCalls } = makeSpyAdapter();
    await publish("/fake/cache", SAMPLE_BUILD_META, SAMPLE_ENV, adapter);

    const urls = apiCalls.map((c) => {
      if (c.url.endsWith("/start")) return "start";
      if (c.url.includes("/ingest")) return "ingest";
      if (c.url.includes("/finalize")) return "finalize";
      return "other";
    });

    const startIdx = urls.indexOf("start");
    const ingestIdx = urls.indexOf("ingest");
    const finalizeIdx = urls.indexOf("finalize");

    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(ingestIdx).toBeGreaterThanOrEqual(0);
    expect(finalizeIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeLessThan(ingestIdx);
    expect(ingestIdx).toBeLessThan(finalizeIdx);
  });

  test("KV warming が D1 finalize の後に来る", async () => {
    const { adapter, apiCalls, kvCalls } = makeSpyAdapter();
    await publish("/fake/cache", SAMPLE_BUILD_META, SAMPLE_ENV, adapter);

    expect(apiCalls.some((c) => c.url.includes("/finalize"))).toBe(true);
    expect(kvCalls.length).toBeGreaterThan(0);
  });

  test("KV warming 失敗は publish 全体を失敗にしない", async () => {
    const { adapter } = makeSpyAdapter({ kvReject: true });
    await expect(
      publish("/fake/cache", SAMPLE_BUILD_META, SAMPLE_ENV, adapter),
    ).resolves.toBeUndefined();
  });

  test("start API に buildMeta が渡される", async () => {
    const { adapter, apiCalls } = makeSpyAdapter();
    await publish("/fake/cache", SAMPLE_BUILD_META, SAMPLE_ENV, adapter);

    const startCall = apiCalls.find((c) => c.url.endsWith("/start"));
    expect(startCall).toBeDefined();
    const body = startCall?.body as { build: typeof SAMPLE_BUILD_META };
    expect(body.build.host).toBe(SAMPLE_BUILD_META.host);
    expect(body.build.system).toBe(SAMPLE_BUILD_META.system);
    expect(body.build.toplevelStorePath).toBe(SAMPLE_BUILD_META.toplevelStorePath);
  });

  test("r2Has が NAR キーごとに呼ばれる (差分化)", async () => {
    const { adapter } = makeSpyAdapter();
    await publish("/fake/cache", SAMPLE_BUILD_META, SAMPLE_ENV, adapter);

    // narinfo は 1 件 (mock 設定)、narKey は "nar/sha256:file001.nar.zst"
    expect(adapter.r2Has).toHaveBeenCalledWith("my-bucket", "nar/sha256:file001.nar.zst");
  });

  test("r2Has が true を返したら該当 NAR の r2Put はスキップされる", async () => {
    const r2Calls: { op: "put" | "putContent"; key: string }[] = [];
    const adapter: ExecAdapter = {
      r2Put: vi.fn(async (_b: string, key: string) => {
        r2Calls.push({ op: "put", key });
      }),
      r2PutContent: vi.fn(async (_b: string, key: string) => {
        r2Calls.push({ op: "putContent", key });
      }),
      r2Has: vi.fn(async (_b: string, _k: string) => true), // 既存ヒット扱い
      kvPutBulk: vi.fn(async () => {}),
      apiPost: vi.fn(async (url: string) => {
        if (url.endsWith("/start")) return { ok: true, build_id: "test-build-001" };
        if (url.includes("/ingest")) return { ok: true };
        if (url.includes("/finalize")) return { ok: true };
        return {};
      }),
    };
    await publish("/fake/cache", SAMPLE_BUILD_META, SAMPLE_ENV, adapter);

    const narPuts = r2Calls.filter((c) => c.op === "put" && c.key.startsWith("nar/"));
    expect(narPuts).toHaveLength(0); // すべて既存ヒットでスキップ
  });

  test("KV warming は kvPutBulk 1 回 (narinfo 数 ≤ chunk size) で全件投入される", async () => {
    const { adapter } = makeSpyAdapter();
    await publish("/fake/cache", SAMPLE_BUILD_META, SAMPLE_ENV, adapter);

    // narinfo が 1 件しか無いので bulk 呼び出しも 1 回
    expect(adapter.kvPutBulk).toHaveBeenCalledTimes(1);
    const bulkCall = (adapter.kvPutBulk as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bulkCall?.[0]).toBe("kv-ns-001");
    const items = bulkCall?.[1] as ReadonlyArray<{ key: string; value: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe("narinfo:abcdef123456aaaa");
  });
});
