/**
 * test/publish/publish-script.test.ts
 *
 * scripts/publish.ts の分類済みplanとbatch publishのユニットテスト。
 *
 * テスト観点:
 *   G4: publish 経路の一本化（closure/manifest put → NAR → narinfo → D1 → KV の順）
 *   G5: closure.json / manifest.json の R2 put・manifestHash が実ハッシュ・
 *       toplevelStorePath が実値・NAR 冪等スキップ
 *   A2: 公開順序保証（closure/manifest → NAR → narinfo → D1 → KV）
 *   A5: 再 publish 冪等（NAR スキップ）
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

let mockNarinfoFiles = ["abcdef123456aaaa.narinfo"];
let mockSelfNarinfoFiles: string[] = [];
let mockFileContents = new Map<string, string>();

// vi.mock はトップレベルに置く必要がある（vitest がホイストするため）
vi.mock("fs/promises", () => ({
  readdir: vi.fn(async (path: string) => String(path).includes("/self") ? mockSelfNarinfoFiles : mockNarinfoFiles),
  readFile: vi.fn(async (path: string, _enc: unknown) => {
    for (const [suffix, content] of mockFileContents) {
      if (String(path).endsWith(suffix)) return content;
    }
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
}));

import {
  type ExecAdapter,
  type NarinfoMeta,
  buildManifestJson,
  parsePublishPlan,
  parseNarinfo,
  publishBatch,
  sha256HexPrefixed,
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

const SAMPLE_ENV = {
  apiBaseUrl: "https://cache.example.com",
  adminToken: "test-token",
  r2BucketName: "my-bucket",
  kvNamespaceId: "kv-ns-001",
};

beforeEach(() => {
  mockNarinfoFiles = ["abcdef123456aaaa.narinfo"];
  mockSelfNarinfoFiles = [];
  mockFileContents = new Map();
});

describe("parsePublishPlan", () => {
  const validPlan = {
    version: 1,
    cacheDir: "/tmp/cache",
    targets: [{
      host: "laptop",
      system: "x86_64-linux",
      gitRev: "deadbeef",
      flakeLockHash: "sha256:lock",
      toplevelStorePath: "/nix/store/laptop-system",
      closureJsonPath: "/tmp/targets/laptop/closure.json",
      closureStorePaths: ["/nix/store/shared", "/nix/store/laptop-system"],
    }],
  };

  test("version 2 の分類済みplanを受理する", () => {
    const plan = {
      version: 2,
      cacheDir: "/tmp/cache",
      selfNarinfoDir: "/tmp/self",
      targets: [{
        ...validPlan.targets[0],
        externalStorePaths: [{ storePath: "/nix/store/shared", substituterUrl: "https://cache.nixos.org" }],
        selfExistingStorePaths: [],
        newStorePaths: ["/nix/store/laptop-system"],
      }],
    };
    expect(parsePublishPlan(plan)).toEqual(plan);
  });

  test("実効設定のHTTP substituterを分類済みplanで受理する", () => {
    const plan = {
      version: 2, cacheDir: "/tmp/cache", selfNarinfoDir: "/tmp/self",
      targets: [{
        ...validPlan.targets[0],
        externalStorePaths: [{ storePath: "/nix/store/shared", substituterUrl: "http://local-cache.example" }],
        selfExistingStorePaths: [],
        newStorePaths: ["/nix/store/laptop-system"],
      }],
    };
    expect(parsePublishPlan(plan)).toEqual(plan);
  });

  test("分類とfull closureが一致しないplanを拒否する", () => {
    expect(() => parsePublishPlan({
      version: 2,
      cacheDir: "/tmp/cache",
      selfNarinfoDir: "/tmp/self",
      targets: [{
        ...validPlan.targets[0],
        externalStorePaths: [{ storePath: "/nix/store/shared", substituterUrl: "https://cache.nixos.org" }],
        selfExistingStorePaths: [],
        newStorePaths: [],
      }],
    })).toThrow(/partition|classification/i);
  });

  test.each([
    [validPlan],
    [{ ...validPlan, targets: [] }],
    [{ ...validPlan, targets: [validPlan.targets[0], validPlan.targets[0]] }],
    [{ ...validPlan, targets: [{ ...validPlan.targets[0], host: "../bad" }] }],
    [{ ...validPlan, cacheDir: "relative/cache" }],
    [{ ...validPlan, adminToken: "must-not-be-in-plan" }],
  ])("不正または曖昧なplanを拒否する", (plan) => {
    expect(() => parsePublishPlan(plan)).toThrow();
  });
});

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

// ─── sha256HexPrefixed ─────────────────────────────────────────────────────────

describe("sha256HexPrefixed", () => {
  test("sha256: プレフィクスを返す", () => {
    expect(sha256HexPrefixed("hello")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("同じ内容なら同じハッシュ", () => {
    expect(sha256HexPrefixed("content")).toBe(sha256HexPrefixed("content"));
  });

  test("内容が違えばハッシュも違う", () => {
    expect(sha256HexPrefixed("aaa")).not.toBe(sha256HexPrefixed("bbb"));
  });

  test("placeholder でない（固定文字列と一致しない）", () => {
    expect(sha256HexPrefixed("some content")).not.toBe("sha256:placeholder");
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
      externalStorePaths: [],
      closureJsonKey: "manifests/build-001/closure.json",
    });
    const obj = JSON.parse(json) as {
      buildId: string;
      toplevelStorePath: string;
      closure: { owned: Array<{ storeHash: string }>; external: unknown[] };
      closureJsonKey: string;
    };
    expect(obj.buildId).toBe("build-001");
    expect(obj.toplevelStorePath).toBe("/nix/store/abcdef123456aaaa-hello-2.12.1");
    expect(obj.closure.owned).toHaveLength(1);
    expect(obj.closure.owned[0]?.storeHash).toBe("abcdef123456aaaa");
    expect(obj.closure.external).toEqual([]);
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
      externalStorePaths: [],
      closureJsonKey: "manifests/b/closure.json",
    });
    expect(json).not.toContain("placeholder");
  });
});

// ─── batch publish ────────────────────────────────────────────────────────────

describe("publishBatch", () => {
  const shared = `StorePath: /nix/store/shared0000000000-shared
URL: nar/shared.nar.zst
Compression: zstd
FileHash: sha256:shared
FileSize: 10
NarHash: sha256:sharednar
NarSize: 20
`;
  const laptopOnly = shared
    .replaceAll("shared0000000000-shared", "laptop000000000-laptop")
    .replaceAll("shared.nar", "laptop.nar")
    .replaceAll("sha256:sharednar", "sha256:laptopnar")
    .replaceAll("sha256:shared", "sha256:laptop");
  const desktopOnly = shared
    .replaceAll("shared0000000000-shared", "desktop000000000-desktop")
    .replaceAll("shared.nar", "desktop.nar")
    .replaceAll("sha256:sharednar", "sha256:desktopnar")
    .replaceAll("sha256:shared", "sha256:desktop");

  function batchPlan() {
    return parsePublishPlan({
      version: 2,
      cacheDir: "/fake/cache",
      selfNarinfoDir: "/fake/self",
      targets: [
        {
          host: "laptop",
          system: "x86_64-linux",
          gitRev: "deadbeef",
          flakeLockHash: "sha256:lock",
          toplevelStorePath: "/nix/store/laptop000000000-laptop",
          closureJsonPath: "/fake/targets/laptop/closure.json",
          closureStorePaths: [
            "/nix/store/shared0000000000-shared",
            "/nix/store/laptop000000000-laptop",
          ],
          externalStorePaths: [],
          selfExistingStorePaths: [],
          newStorePaths: [
            "/nix/store/shared0000000000-shared",
            "/nix/store/laptop000000000-laptop",
          ],
        },
        {
          host: "desktop",
          system: "x86_64-linux",
          gitRev: "deadbeef",
          flakeLockHash: "sha256:lock",
          toplevelStorePath: "/nix/store/desktop000000000-desktop",
          closureJsonPath: "/fake/targets/desktop/closure.json",
          closureStorePaths: [
            "/nix/store/shared0000000000-shared",
            "/nix/store/desktop000000000-desktop",
          ],
          externalStorePaths: [],
          selfExistingStorePaths: [],
          newStorePaths: [
            "/nix/store/shared0000000000-shared",
            "/nix/store/desktop000000000-desktop",
          ],
        },
      ],
    });
  }

  function batchAdapter() {
    const sequence: string[] = [];
    const manifests = new Map<string, string>();
    const adapter: ExecAdapter = {
      r2Put: vi.fn(async (_bucket, key) => {
        sequence.push(`r2:${key}`);
      }),
      r2PutContent: vi.fn(async (_bucket, key, content) => {
        sequence.push(`r2:${key}`);
        manifests.set(key, content);
      }),
      r2Has: vi.fn(async (_bucket, key) => {
        sequence.push(`head:${key}`);
        return false;
      }),
      kvPutBulk: vi.fn(async () => {
        sequence.push("kv");
      }),
      apiPost: vi.fn(async (url, _token, body) => {
        if (url.endsWith("/start")) {
          const id = (body as { build: { id: string } }).build.id;
          sequence.push(`start:${id}`);
          return { build_id: id };
        }
        if (url.endsWith("/ingest")) sequence.push(`ingest:${url}`);
        if (url.endsWith("/finalize")) sequence.push(`finalize:${url}`);
        return {};
      }),
    };
    return { adapter, sequence, manifests };
  }

  beforeEach(() => {
    mockNarinfoFiles = [
      "shared0000000000.narinfo",
      "laptop000000000.narinfo",
      "desktop000000000.narinfo",
    ];
    mockFileContents = new Map([
      ["shared0000000000.narinfo", shared],
      ["laptop000000000.narinfo", laptopOnly],
      ["desktop000000000.narinfo", desktopOnly],
    ]);
  });

  test("ホストごとのclosureを分離しshared pathだけを共有する", async () => {
    const { adapter, manifests } = batchAdapter();
    await publishBatch(batchPlan(), SAMPLE_ENV, adapter);

    const parsed = [...manifests.entries()]
      .filter(([key]) => key.endsWith("manifest.json"))
      .map(([, value]) => JSON.parse(value) as { host: string; closure: { owned: Array<{ storePath: string }> } });
    const laptop = parsed.find((manifest) => manifest.host === "laptop");
    const desktop = parsed.find((manifest) => manifest.host === "desktop");
    expect(laptop?.closure.owned.map((path) => path.storePath)).toEqual([
      "/nix/store/shared0000000000-shared",
      "/nix/store/laptop000000000-laptop",
    ]);
    expect(desktop?.closure.owned.map((path) => path.storePath)).toEqual([
      "/nix/store/shared0000000000-shared",
      "/nix/store/desktop000000000-desktop",
    ]);
  });

  test("共有NAR/narinfoを一度だけuploadしKVを和集合で一度だけwarmingする", async () => {
    const { adapter } = batchAdapter();
    await publishBatch(batchPlan(), SAMPLE_ENV, adapter);

    expect(adapter.r2Has).toHaveBeenCalledTimes(3);
    const r2Put = adapter.r2Put as ReturnType<typeof vi.fn>;
    expect(r2Put.mock.calls.filter((call) => String(call[1]).startsWith("nar/"))).toHaveLength(3);
    expect(r2Put.mock.calls.filter((call) => String(call[1]).endsWith(".narinfo"))).toHaveLength(3);
    expect(adapter.kvPutBulk).toHaveBeenCalledTimes(1);
    expect((adapter.kvPutBulk as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toHaveLength(3);
  });

  test("externalはmanifestだけ、self-existingは世代参照だけ、新規pathだけuploadする", async () => {
    mockNarinfoFiles = ["laptop000000000.narinfo"];
    mockSelfNarinfoFiles = ["shared0000000000.narinfo"];
    const plan = parsePublishPlan({
      version: 2,
      cacheDir: "/fake/cache",
      selfNarinfoDir: "/fake/self",
      targets: [{
        host: "laptop", system: "x86_64-linux", gitRev: "deadbeef",
        flakeLockHash: "sha256:lock",
        toplevelStorePath: "/nix/store/laptop000000000-laptop",
        closureJsonPath: "/fake/targets/laptop/closure.json",
        closureStorePaths: [
          "/nix/store/external00000000-external",
          "/nix/store/shared0000000000-shared",
          "/nix/store/laptop000000000-laptop",
        ],
        externalStorePaths: [{
          storePath: "/nix/store/external00000000-external",
          substituterUrl: "https://cache.nixos.org",
        }],
        selfExistingStorePaths: ["/nix/store/shared0000000000-shared"],
        newStorePaths: ["/nix/store/laptop000000000-laptop"],
      }],
    });
    const { adapter, manifests } = batchAdapter();
    vi.mocked(adapter.r2Has).mockImplementation(async (_bucket, key) => key === "nar/shared.nar.zst");
    await publishBatch(plan, SAMPLE_ENV, adapter);

    const manifest = JSON.parse([...manifests.values()][0]!) as {
      closure: {
        owned: Array<{ storePath: string }>;
        external: Array<{ storePath: string; substituterUrl: string }>;
      };
    };
    expect(manifest.closure.owned.map((row) => row.storePath)).toEqual([
      "/nix/store/shared0000000000-shared",
      "/nix/store/laptop000000000-laptop",
    ]);
    expect(manifest.closure.external).toEqual([{
      storePath: "/nix/store/external00000000-external",
      substituterUrl: "https://cache.nixos.org",
    }]);
    const ingested = (adapter.apiPost as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => String(call[0]).endsWith("/ingest"))
      .flatMap((call) => (call[2] as { storePaths: Array<{ storePath: string }> }).storePaths);
    expect(ingested.map((row) => row.storePath)).toEqual(manifest.closure.owned.map((row) => row.storePath));
    expect((adapter.r2Put as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[1])
      .filter((key) => String(key).startsWith("nar/") || String(key).endsWith(".narinfo")))
      .toEqual(["nar/laptop.nar.zst", "shared0000000000.narinfo", "laptop000000000.narinfo"]);
    expect((adapter.r2Put as ReturnType<typeof vi.fn>).mock.calls
      .find((call) => call[1] === "shared0000000000.narinfo")?.[2])
      .toBe("/fake/self/shared0000000000.narinfo");

  });

  test("self-existing NAR が R2 から消えていれば finalize しない", async () => {
    mockNarinfoFiles = [];
    mockSelfNarinfoFiles = ["shared0000000000.narinfo"];
    const plan = parsePublishPlan({
      version: 2, cacheDir: "/fake/cache", selfNarinfoDir: "/fake/self",
      targets: [{
        host: "shared", system: "x86_64-linux", gitRev: "deadbeef",
        flakeLockHash: "sha256:lock",
        toplevelStorePath: "/nix/store/shared0000000000-shared",
        closureJsonPath: "/fake/targets/shared/closure.json",
        closureStorePaths: ["/nix/store/shared0000000000-shared"],
        externalStorePaths: [],
        selfExistingStorePaths: ["/nix/store/shared0000000000-shared"],
        newStorePaths: [],
      }],
    });
    const { adapter } = batchAdapter();
    await expect(publishBatch(plan, SAMPLE_ENV, adapter)).rejects.toThrow("self-existing NAR missing");
    expect((adapter.apiPost as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => String(call[0]).endsWith("/finalize"))).toHaveLength(0);
  });

  test("所有区分が変わる再試行は別build IDになる", async () => {
    const target = {
      host: "shared", system: "x86_64-linux", gitRev: "deadbeef",
      flakeLockHash: "sha256:lock",
      toplevelStorePath: "/nix/store/shared0000000000-shared",
      closureJsonPath: "/fake/targets/shared/closure.json",
      closureStorePaths: ["/nix/store/shared0000000000-shared"],
    };
    const plan = (external: boolean) => parsePublishPlan({
      version: 2, cacheDir: "/fake/cache", selfNarinfoDir: "/fake/self",
      targets: [{
        ...target,
        externalStorePaths: external ? [{
          storePath: target.toplevelStorePath,
          substituterUrl: "https://cache.nixos.org",
        }] : [],
        selfExistingStorePaths: [],
        newStorePaths: external ? [] : [target.toplevelStorePath],
      }],
    });
    const { adapter } = batchAdapter();
    mockNarinfoFiles = [];
    await publishBatch(plan(true), SAMPLE_ENV, adapter);
    mockNarinfoFiles = ["shared0000000000.narinfo"];
    await publishBatch(plan(false), SAMPLE_ENV, adapter);
    const starts = (adapter.apiPost as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => String(call[0]).endsWith("/start"))
      .map((call) => (call[2] as { build: { id: string } }).build.id);
    expect(starts[0]).not.toBe(starts[1]);
  });

  test("全start/ingest、manifest、NAR、narinfo、全finalize、KVの順序を守る", async () => {
    const { adapter, sequence } = batchAdapter();
    await publishBatch(batchPlan(), SAMPLE_ENV, adapter);

    const lastIngest = sequence.map((item) => item.startsWith("ingest:")).lastIndexOf(true);
    const firstManifest = sequence.findIndex((item) => item.includes("manifest.json"));
    const firstNar = sequence.findIndex((item) => item.startsWith("r2:nar/"));
    const firstNarinfo = sequence.findIndex((item) => item.endsWith(".narinfo"));
    const firstFinalize = sequence.findIndex((item) => item.startsWith("finalize:"));
    const lastFinalize = sequence.map((item) => item.startsWith("finalize:")).lastIndexOf(true);
    const kv = sequence.indexOf("kv");
    expect(lastIngest).toBeLessThan(firstManifest);
    expect(firstManifest).toBeLessThan(firstNar);
    expect(firstNar).toBeLessThan(firstNarinfo);
    expect(firstNarinfo).toBeLessThan(firstFinalize);
    expect(lastFinalize).toBeLessThan(kv);
  });
});
