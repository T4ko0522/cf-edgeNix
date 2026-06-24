/**
 * test/schemas/publish.test.ts
 *
 * src/schemas/publish.ts の zod schema 境界値テスト。
 * narSize/fileSize/narHash/compression 等の不正値を確認する。
 * 受入条件: B4/F1/G6
 */
import { describe, expect, test } from "vitest";
import {
  NarinfoMetaSchema,
  BuildMetaSchema,
  ManifestMetaSchema,
  PublishStartRequestSchema,
  PublishIngestRequestSchema,
  PublishFinalizeRequestSchema,
} from "../../src/schemas/publish";

// ─── サンプルフィクスチャ ─────────────────────────────────────────────────────

// ─── フィクスチャは新しい制約（修正11）に合わせた実形式 ─────────────────────────

// storeHash: 小文字 base32 (Nix base32 は [0-9a-z] で 32 文字)
const STORE_HASH = "aaaa0000bbbb11112222333344445555";
// storePath: /nix/store/<hash>-<name>
const STORE_PATH = `/nix/store/${STORE_HASH}-pkg`;
// fileHash / narHash: sha256:<64桁 hex>
const FILE_HASH = "sha256:" + "a".repeat(64);
const NAR_HASH = "sha256:" + "b".repeat(64);
// narKey: nar/<base32>.nar.zst
const NAR_KEY = `nar/${STORE_HASH}.nar.zst`;

const validNarinfoMeta = {
  storeHash: STORE_HASH,
  storePath: STORE_PATH,
  narinfoKey: `${STORE_HASH}.narinfo`,
  narKey: NAR_KEY,
  narHash: NAR_HASH,
  narSize: 1000,
  fileHash: FILE_HASH,
  fileSize: 500,
  compression: "zstd",
};

const BUILD_STORE_HASH = "ccccddddeeeeffffaaaabbbbccccdddd";
const validBuildMeta = {
  id: "build-001",
  host: "test-host",
  system: "x86_64-linux",
  gitRev: "deadbeef",
  flakeLockHash: "sha256:lock",
  toplevelStorePath: `/nix/store/${BUILD_STORE_HASH}-toplevel`,
  createdAt: 1700000000000,
};

const MANIFEST_STORE_HASH = "aaaabbbbccccddddeeeeffffaaaabbbb";
const validManifestMeta = {
  host: "test-host",
  system: "x86_64-linux",
  gitRev: "deadbeef",
  flakeLockHash: "sha256:lock",
  toplevelStorePath: `/nix/store/${MANIFEST_STORE_HASH}-toplevel`,
  closureJsonKey: "manifests/build-001/closure.json",
  manifestKey: "manifests/build-001/manifest.json",
  manifestHash: "sha256:" + "c".repeat(64),
};

// ─── NarinfoMetaSchema ───────────────────────────────────────────────────────

describe("NarinfoMetaSchema", () => {
  test("有効な値 → 成功", () => {
    expect(NarinfoMetaSchema.safeParse(validNarinfoMeta).success).toBe(true);
  });

  describe("narSize 境界", () => {
    test("narSize が 1 → 成功（最小正の整数）", () => {
      expect(NarinfoMetaSchema.safeParse({ ...validNarinfoMeta, narSize: 1 }).success).toBe(true);
    });

    test("narSize が 0 → 失敗（positive integer が要件）", () => {
      expect(NarinfoMetaSchema.safeParse({ ...validNarinfoMeta, narSize: 0 }).success).toBe(false);
    });

    test("narSize が -1 → 失敗（negative）", () => {
      expect(NarinfoMetaSchema.safeParse({ ...validNarinfoMeta, narSize: -1 }).success).toBe(false);
    });

    test("narSize が 1.5 → 失敗（非整数）", () => {
      expect(NarinfoMetaSchema.safeParse({ ...validNarinfoMeta, narSize: 1.5 }).success).toBe(false);
    });

    test("narSize が 0.5 → 失敗（非整数かつ非正）", () => {
      expect(NarinfoMetaSchema.safeParse({ ...validNarinfoMeta, narSize: 0.5 }).success).toBe(false);
    });

    test("narSize が文字列 → 失敗", () => {
      expect(NarinfoMetaSchema.safeParse({ ...validNarinfoMeta, narSize: "1000" }).success).toBe(false);
    });

    test("narSize が欠落 → 失敗", () => {
      const { narSize: _, ...rest } = validNarinfoMeta;
      expect(NarinfoMetaSchema.safeParse(rest).success).toBe(false);
    });
  });

  describe("fileSize 境界", () => {
    test("fileSize が 0 → 失敗", () => {
      expect(NarinfoMetaSchema.safeParse({ ...validNarinfoMeta, fileSize: 0 }).success).toBe(false);
    });

    test("fileSize が -100 → 失敗", () => {
      expect(NarinfoMetaSchema.safeParse({ ...validNarinfoMeta, fileSize: -100 }).success).toBe(false);
    });

    test("fileSize が 2.5 → 失敗（非整数）", () => {
      expect(NarinfoMetaSchema.safeParse({ ...validNarinfoMeta, fileSize: 2.5 }).success).toBe(false);
    });
  });

  describe("storeHash 境界", () => {
    test("storeHash に大文字 → 失敗", () => {
      expect(NarinfoMetaSchema.safeParse({ ...validNarinfoMeta, storeHash: "AAAA0000" }).success).toBe(false);
    });

    test("storeHash が空文字 → 失敗", () => {
      expect(NarinfoMetaSchema.safeParse({ ...validNarinfoMeta, storeHash: "" }).success).toBe(false);
    });

    test("storeHash にハイフン → 失敗", () => {
      expect(NarinfoMetaSchema.safeParse({ ...validNarinfoMeta, storeHash: "aaaa-0000" }).success).toBe(false);
    });
  });

  describe("compression 境界", () => {
    test("compression が空文字 → 失敗", () => {
      expect(NarinfoMetaSchema.safeParse({ ...validNarinfoMeta, compression: "" }).success).toBe(false);
    });

    test("compression が zstd → 成功", () => {
      expect(NarinfoMetaSchema.safeParse({ ...validNarinfoMeta, compression: "zstd" }).success).toBe(true);
    });

    test("compression が xz → 成功（他形式も許容）", () => {
      expect(NarinfoMetaSchema.safeParse({ ...validNarinfoMeta, compression: "xz" }).success).toBe(true);
    });
  });

  describe("必須フィールド欠落", () => {
    const requiredFields = [
      "storeHash", "storePath", "narinfoKey", "narKey",
      "narHash", "fileHash", "compression",
    ] as const;

    for (const field of requiredFields) {
      test(`${field} が欠落 → 失敗`, () => {
        const input = { ...validNarinfoMeta } as Record<string, unknown>;
        delete input[field];
        expect(NarinfoMetaSchema.safeParse(input).success).toBe(false);
      });
    }
  });

  test("firstSeenBuildId は省略可能", () => {
    const { firstSeenBuildId: _, ...rest } = { ...validNarinfoMeta, firstSeenBuildId: "build-1" };
    expect(NarinfoMetaSchema.safeParse(rest).success).toBe(true);
  });
});

// ─── BuildMetaSchema ─────────────────────────────────────────────────────────

describe("BuildMetaSchema", () => {
  test("有効な値 → 成功", () => {
    expect(BuildMetaSchema.safeParse(validBuildMeta).success).toBe(true);
  });

  test("createdAt が 0 → 失敗（positive が要件）", () => {
    expect(BuildMetaSchema.safeParse({ ...validBuildMeta, createdAt: 0 }).success).toBe(false);
  });

  test("createdAt が -1 → 失敗", () => {
    expect(BuildMetaSchema.safeParse({ ...validBuildMeta, createdAt: -1 }).success).toBe(false);
  });

  test("createdAt が 1.5 → 失敗（非整数）", () => {
    expect(BuildMetaSchema.safeParse({ ...validBuildMeta, createdAt: 1.5 }).success).toBe(false);
  });

  test("host に @記号 → 失敗（HostSchema）", () => {
    expect(BuildMetaSchema.safeParse({ ...validBuildMeta, host: "host@domain" }).success).toBe(false);
  });

  test("id にアンダースコア → 失敗（BuildIdSchema）", () => {
    expect(BuildMetaSchema.safeParse({ ...validBuildMeta, id: "build_001" }).success).toBe(false);
  });

  test("system が空文字 → 失敗", () => {
    expect(BuildMetaSchema.safeParse({ ...validBuildMeta, system: "" }).success).toBe(false);
  });
});

// ─── ManifestMetaSchema ───────────────────────────────────────────────────────

describe("ManifestMetaSchema", () => {
  test("有効な値 → 成功", () => {
    expect(ManifestMetaSchema.safeParse(validManifestMeta).success).toBe(true);
  });

  test("closureJsonKey が空文字 → 失敗", () => {
    expect(ManifestMetaSchema.safeParse({ ...validManifestMeta, closureJsonKey: "" }).success).toBe(false);
  });

  test("manifestHash が空文字 → 失敗", () => {
    expect(ManifestMetaSchema.safeParse({ ...validManifestMeta, manifestHash: "" }).success).toBe(false);
  });
});

// ─── PublishStartRequestSchema ────────────────────────────────────────────────

describe("PublishStartRequestSchema", () => {
  test("有効な値 → 成功", () => {
    expect(PublishStartRequestSchema.safeParse({ build: validBuildMeta }).success).toBe(true);
  });

  test("build フィールドが欠落 → 失敗", () => {
    expect(PublishStartRequestSchema.safeParse({}).success).toBe(false);
  });

  test("build.createdAt が 0 → 失敗", () => {
    expect(
      PublishStartRequestSchema.safeParse({ build: { ...validBuildMeta, createdAt: 0 } }).success,
    ).toBe(false);
  });
});

// ─── PublishIngestRequestSchema ───────────────────────────────────────────────

describe("PublishIngestRequestSchema", () => {
  test("有効な値（1 件）→ 成功", () => {
    expect(PublishIngestRequestSchema.safeParse({ storePaths: [validNarinfoMeta] }).success).toBe(true);
  });

  test("空配列 → 成功（0 件 ingest）", () => {
    expect(PublishIngestRequestSchema.safeParse({ storePaths: [] }).success).toBe(true);
  });

  test("storePaths フィールドが欠落 → 失敗", () => {
    expect(PublishIngestRequestSchema.safeParse({}).success).toBe(false);
  });

  test("storePaths に不正な narSize (0) が含まれる → 失敗", () => {
    expect(
      PublishIngestRequestSchema.safeParse({
        storePaths: [{ ...validNarinfoMeta, narSize: 0 }],
      }).success,
    ).toBe(false);
  });

  test("storePaths の 1 件に大文字 storeHash → 失敗（G6: zod 検証）", () => {
    expect(
      PublishIngestRequestSchema.safeParse({
        storePaths: [{ ...validNarinfoMeta, storeHash: "AAAA0000BBBB1111" }],
      }).success,
    ).toBe(false);
  });
});

// ─── PublishFinalizeRequestSchema ─────────────────────────────────────────────

describe("PublishFinalizeRequestSchema", () => {
  test("有効な値 → 成功", () => {
    expect(PublishFinalizeRequestSchema.safeParse({ manifest: validManifestMeta }).success).toBe(true);
  });

  test("manifest フィールドが欠落 → 失敗", () => {
    expect(PublishFinalizeRequestSchema.safeParse({}).success).toBe(false);
  });

  test("manifest.host が無効（スペース含む）→ 失敗", () => {
    expect(
      PublishFinalizeRequestSchema.safeParse({
        manifest: { ...validManifestMeta, host: "host with space" },
      }).success,
    ).toBe(false);
  });
});
