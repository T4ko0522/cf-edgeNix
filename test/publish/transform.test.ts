/**
 * test/publish/transform.test.ts
 *
 * `parseNarinfo` / `buildPublishPayload` の単体テスト。
 * 受入条件: A1（narinfo → NarinfoMeta 変換）/ A4（closure/manifest 情報組立）
 */
import { describe, expect, test } from "vitest";
import { buildPublishPayload, parseNarinfo } from "../../src/publish/transform";
import type { BuildMeta, ManifestMeta, NarinfoMeta } from "../../src/publish/types";

// ─── サンプル narinfo テキスト ────────────────────────────────────────────────

/**
 * 実際の Nix binary cache の .narinfo フォーマットに準拠。
 * storeHash = "abcdef123456aaaa"（StorePath のスラッシュ後の最初のセグメント）
 */
const SAMPLE_NARINFO = `StorePath: /nix/store/abcdef123456aaaa-hello-2.12.1
URL: nar/sha256:xxxx1234567890abcdef.nar.zst
Compression: zstd
FileHash: sha256:aaaa1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab
FileSize: 12345
NarHash: sha256:bbbb1234567890abcdef1234567890abcdef1234567890abcdef1234567890cd
NarSize: 67890
References: abcdef123456aaaa-hello-2.12.1 00000000000000000000-glibc-2.38
Sig: cache.example.com-1:AAAABBBBCCCCDDDD==
`;

// References を持たない（単独パッケージ）
const NARINFO_NO_REFS = `StorePath: /nix/store/zzzzzz999999zzzz-standalone-1.0
URL: nar/sha256:zzzz0000.nar.zst
Compression: zstd
FileHash: sha256:cccc0000000000000000000000000000000000000000000000000000000000aa
FileSize: 100
NarHash: sha256:dddd0000000000000000000000000000000000000000000000000000000000bb
NarSize: 200
References:
`;

// ─── parseNarinfo 正常系 ──────────────────────────────────────────────────────

describe("parseNarinfo", () => {
  describe("正常系: 全フィールド抽出", () => {
    test("storeHash を正しく抽出する（StorePath の hash 部）", () => {
      const meta = parseNarinfo(SAMPLE_NARINFO);
      expect(meta.storeHash).toBe("abcdef123456aaaa");
    });

    test("storePath を正しく抽出する", () => {
      const meta = parseNarinfo(SAMPLE_NARINFO);
      expect(meta.storePath).toBe("/nix/store/abcdef123456aaaa-hello-2.12.1");
    });

    test("narHash を正しく抽出する", () => {
      const meta = parseNarinfo(SAMPLE_NARINFO);
      expect(meta.narHash).toBe(
        "sha256:bbbb1234567890abcdef1234567890abcdef1234567890abcdef1234567890cd",
      );
    });

    test("narSize を数値として正しく抽出する", () => {
      const meta = parseNarinfo(SAMPLE_NARINFO);
      expect(meta.narSize).toBe(67890);
    });

    test("fileHash を正しく抽出する", () => {
      const meta = parseNarinfo(SAMPLE_NARINFO);
      expect(meta.fileHash).toBe(
        "sha256:aaaa1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
      );
    });

    test("fileSize を数値として正しく抽出する", () => {
      const meta = parseNarinfo(SAMPLE_NARINFO);
      expect(meta.fileSize).toBe(12345);
    });

    test("compression を正しく抽出する", () => {
      const meta = parseNarinfo(SAMPLE_NARINFO);
      expect(meta.compression).toBe("zstd");
    });

    test("narinfoKey が '<storeHash>.narinfo' 形式になる", () => {
      const meta = parseNarinfo(SAMPLE_NARINFO);
      expect(meta.narinfoKey).toBe("abcdef123456aaaa.narinfo");
    });

    test("narKey が URL フィールドの値（nar/<fileHash>.nar.zst 形式）になる", () => {
      const meta = parseNarinfo(SAMPLE_NARINFO);
      // URL フィールドを narKey として使う
      expect(meta.narKey).toBe("nar/sha256:xxxx1234567890abcdef.nar.zst");
    });
  });

  describe("References なし（空行）でも正常にパースできる", () => {
    test("References が空でも storeHash を抽出できる", () => {
      const meta = parseNarinfo(NARINFO_NO_REFS);
      expect(meta.storeHash).toBe("zzzzzz999999zzzz");
    });

    test("References が空でも narSize を抽出できる", () => {
      const meta = parseNarinfo(NARINFO_NO_REFS);
      expect(meta.narSize).toBe(200);
    });
  });

  // ─── parseNarinfo 異常系 ────────────────────────────────────────────────────

  describe("異常系: 必須フィールド欠落", () => {
    test("StorePath がない → Error を throw する", () => {
      const text = SAMPLE_NARINFO.replace(/^StorePath:.*\n/m, "");
      expect(() => parseNarinfo(text)).toThrow();
    });

    test("NarHash がない → Error を throw する", () => {
      const text = SAMPLE_NARINFO.replace(/^NarHash:.*\n/m, "");
      expect(() => parseNarinfo(text)).toThrow();
    });

    test("NarSize がない → Error を throw する", () => {
      const text = SAMPLE_NARINFO.replace(/^NarSize:.*\n/m, "");
      expect(() => parseNarinfo(text)).toThrow();
    });

    test("FileHash がない → Error を throw する", () => {
      const text = SAMPLE_NARINFO.replace(/^FileHash:.*\n/m, "");
      expect(() => parseNarinfo(text)).toThrow();
    });

    test("FileSize がない → Error を throw する", () => {
      const text = SAMPLE_NARINFO.replace(/^FileSize:.*\n/m, "");
      expect(() => parseNarinfo(text)).toThrow();
    });

    test("Compression がない → Error を throw する", () => {
      const text = SAMPLE_NARINFO.replace(/^Compression:.*\n/m, "");
      expect(() => parseNarinfo(text)).toThrow();
    });

    test("URL がない → Error を throw する", () => {
      const text = SAMPLE_NARINFO.replace(/^URL:.*\n/m, "");
      expect(() => parseNarinfo(text)).toThrow();
    });

    test("空文字列 → Error を throw する", () => {
      expect(() => parseNarinfo("")).toThrow();
    });
  });

  describe("異常系: 型不正", () => {
    test("NarSize が数値でない → Error を throw する", () => {
      const text = SAMPLE_NARINFO.replace(/^NarSize: \d+/m, "NarSize: notanumber");
      expect(() => parseNarinfo(text)).toThrow();
    });

    test("FileSize が数値でない → Error を throw する", () => {
      const text = SAMPLE_NARINFO.replace(/^FileSize: \d+/m, "FileSize: abc");
      expect(() => parseNarinfo(text)).toThrow();
    });
  });
});

// ─── buildPublishPayload ─────────────────────────────────────────────────────

describe("buildPublishPayload", () => {
  const sampleBuildMeta: BuildMeta = {
    id: "build-001",
    host: "my-host.example.com",
    system: "x86_64-linux",
    gitRev: "abc123def456",
    flakeLockHash: "sha256:locklocklocklock",
    toplevelStorePath: "/nix/store/abcdef123456aaaa-hello-2.12.1",
    createdAt: 1700000000000,
  };

  const sampleNarinfo: NarinfoMeta = {
    storeHash: "abcdef123456aaaa",
    storePath: "/nix/store/abcdef123456aaaa-hello-2.12.1",
    narHash: "sha256:bbbb1234567890abcdef1234567890abcdef1234567890abcdef1234567890cd",
    narSize: 67890,
    fileHash: "sha256:aaaa1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
    fileSize: 12345,
    compression: "zstd",
    narinfoKey: "abcdef123456aaaa.narinfo",
    narKey: "nar/sha256:xxxx1234567890abcdef.nar.zst",
  };

  const sampleManifest: ManifestMeta & {
    host: string;
    system: string;
    gitRev: string;
    flakeLockHash: string;
    toplevelStorePath: string;
  } = {
    closureJsonKey: "manifests/build-001/closure.json",
    manifestKey: "manifests/build-001/manifest.json",
    manifestHash: "sha256:manifesthashhash",
    host: "my-host.example.com",
    system: "x86_64-linux",
    gitRev: "abc123def456",
    flakeLockHash: "sha256:locklocklocklock",
    toplevelStorePath: "/nix/store/abcdef123456aaaa-hello-2.12.1",
  };

  test("build フィールドが buildMeta と一致する", () => {
    const payload = buildPublishPayload({
      buildMeta: sampleBuildMeta,
      narinfos: [sampleNarinfo],
      manifest: sampleManifest,
    });
    expect(payload.build).toEqual(sampleBuildMeta);
  });

  test("storePaths が narinfos と一致する", () => {
    const payload = buildPublishPayload({
      buildMeta: sampleBuildMeta,
      narinfos: [sampleNarinfo],
      manifest: sampleManifest,
    });
    expect(payload.storePaths).toEqual([sampleNarinfo]);
  });

  test("manifest フィールドが入力 manifest と一致する", () => {
    const payload = buildPublishPayload({
      buildMeta: sampleBuildMeta,
      narinfos: [sampleNarinfo],
      manifest: sampleManifest,
    });
    expect(payload.manifest).toEqual(sampleManifest);
  });

  test("narinfos が複数でも storePaths にそのまま入る", () => {
    const second: NarinfoMeta = { ...sampleNarinfo, storeHash: "zzzz000000000000" };
    const payload = buildPublishPayload({
      buildMeta: sampleBuildMeta,
      narinfos: [sampleNarinfo, second],
      manifest: sampleManifest,
    });
    expect(payload.storePaths).toHaveLength(2);
  });

  test("narinfos が空でも payload が作れる（空 closure）", () => {
    const payload = buildPublishPayload({
      buildMeta: sampleBuildMeta,
      narinfos: [],
      manifest: sampleManifest,
    });
    expect(payload.storePaths).toEqual([]);
  });
});
