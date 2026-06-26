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

  describe("narHash / fileHash 形式", () => {
    // Nix が narinfo に実出力する Nix-base32 (e/o/t/u を除外した [0-9a-df-np-sv-z])。
    // 既定の `nix copy --to file://...` 出力はこの形になる。
    const NIX_BASE32_HASH = "sha256:0pyfgwnyk3pqzgr3qqd9khsa1k1akl04bwpa3wnk7xfvjnvfwbf4";
    // SRI 形 (sha256-<base64>=)。modern Nix の一部経路で出る。
    const SRI_HASH = "sha256-q1MqDP3p9c+aE6m2YsP3vRwjLk2sZmYbN0Q3rXY+aBc=";

    test("narHash が Nix-base32 → 成功 (本番 narinfo の実形式)", () => {
      expect(
        NarinfoMetaSchema.safeParse({ ...validNarinfoMeta, narHash: NIX_BASE32_HASH }).success,
      ).toBe(true);
    });

    test("fileHash が Nix-base32 → 成功", () => {
      expect(
        NarinfoMetaSchema.safeParse({ ...validNarinfoMeta, fileHash: NIX_BASE32_HASH }).success,
      ).toBe(true);
    });

    test("narHash が SRI (sha256-<base64>=) → 成功", () => {
      expect(
        NarinfoMetaSchema.safeParse({ ...validNarinfoMeta, narHash: SRI_HASH }).success,
      ).toBe(true);
    });

    test("narHash に hex でも Nix-base32 でもない 'o' が含まれる → 失敗", () => {
      // hex は [0-9a-f] なので o は不可。Nix-base32 も e/o/t/u を除外しているので o は不可。
      // 両方の alternation で弾かれることを保証する。
      expect(
        NarinfoMetaSchema.safeParse({
          ...validNarinfoMeta,
          narHash: "sha256:" + "o".repeat(52),
        }).success,
      ).toBe(false);
    });

    test("narHash に大文字 → 失敗 (hex/base32 いずれも小文字限定)", () => {
      expect(
        NarinfoMetaSchema.safeParse({
          ...validNarinfoMeta,
          narHash: "sha256:" + "A".repeat(64),
        }).success,
      ).toBe(false);
    });

    test("narHash がプレフィックスなし → 失敗", () => {
      expect(
        NarinfoMetaSchema.safeParse({
          ...validNarinfoMeta,
          narHash: "0".repeat(64),
        }).success,
      ).toBe(false);
    });

    describe("長さ境界 (sha256 の各 encoding に固定)", () => {
      test("hex が 63 文字 → 失敗", () => {
        expect(
          NarinfoMetaSchema.safeParse({
            ...validNarinfoMeta,
            narHash: "sha256:" + "a".repeat(63),
          }).success,
        ).toBe(false);
      });

      test("hex が 65 文字 → 失敗", () => {
        expect(
          NarinfoMetaSchema.safeParse({
            ...validNarinfoMeta,
            narHash: "sha256:" + "a".repeat(65),
          }).success,
        ).toBe(false);
      });

      test("Nix-base32 が 51 文字 → 失敗", () => {
        expect(
          NarinfoMetaSchema.safeParse({
            ...validNarinfoMeta,
            // 全 alphabet 内字だが 1 文字足りない
            narHash: "sha256:" + "a".repeat(51),
          }).success,
        ).toBe(false);
      });

      test("Nix-base32 が 53 文字 → 失敗", () => {
        expect(
          NarinfoMetaSchema.safeParse({
            ...validNarinfoMeta,
            narHash: "sha256:" + "a".repeat(53),
          }).success,
        ).toBe(false);
      });

      test("SRI が base64 43 文字 + パディングなし → 失敗", () => {
        expect(
          NarinfoMetaSchema.safeParse({
            ...validNarinfoMeta,
            narHash: "sha256-q1MqDP3p9c+aE6m2YsP3vRwjLk2sZmYbN0Q3rXY+aBc",
          }).success,
        ).toBe(false);
      });

      test("SRI が base64 42 文字 + パディング → 失敗 (長さ不足)", () => {
        expect(
          NarinfoMetaSchema.safeParse({
            ...validNarinfoMeta,
            narHash: "sha256-" + "A".repeat(42) + "=",
          }).success,
        ).toBe(false);
      });
    });

    describe("Nix-base32 除外文字 (e/o/t/u) は長さ 52 でも禁止", () => {
      // hex の長さ固定 (64) により、52 文字なら必ず base32 側で評価される。
      // 除外文字を 52 文字並べた値が弾かれることで alphabet 制約を保証する。
      for (const c of ["e", "o", "t", "u"] as const) {
        test(`'${c}' を 52 文字 → 失敗`, () => {
          expect(
            NarinfoMetaSchema.safeParse({
              ...validNarinfoMeta,
              narHash: "sha256:" + c.repeat(52),
            }).success,
          ).toBe(false);
        });
      }
    });

    describe("Nix-base32 alphabet 境界文字 (range 記述ミス検出)", () => {
      // `[0-9a-df-np-sv-z]` の各 range の両端 (d/f, n/p, s/v) を 52 文字並べて全て成功すること。
      for (const c of ["d", "f", "n", "p", "s", "v"] as const) {
        test(`'${c}' を 52 文字 → 成功`, () => {
          expect(
            NarinfoMetaSchema.safeParse({
              ...validNarinfoMeta,
              narHash: "sha256:" + c.repeat(52),
            }).success,
          ).toBe(true);
        });
      }
    });
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

  test("manifest.manifestHash が Nix-base32 → 成功 (sha256 各 encoding 受理の保証)", () => {
    expect(
      PublishFinalizeRequestSchema.safeParse({
        manifest: {
          ...validManifestMeta,
          manifestHash: "sha256:0pyfgwnyk3pqzgr3qqd9khsa1k1akl04bwpa3wnk7xfvjnvfwbf4",
        },
      }).success,
    ).toBe(true);
  });
});
