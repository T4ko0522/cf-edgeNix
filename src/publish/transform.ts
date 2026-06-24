import type { BuildMeta, ManifestMeta, NarinfoMeta, PublishPayload } from "./types";

/**
 * .narinfo テキストを NarinfoMeta にパースする純粋関数。
 *
 * 期待するフィールド:
 *   StorePath, NarHash, NarSize, FileHash, FileSize, Compression, URL
 *
 * パース失敗（必須フィールド欠落）は Error を throw する。
 * R2 key は storage/keys の命名規則に従い算出する（narinfoKey / narKey）。
 */
export function parseNarinfo(text: string): NarinfoMeta {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) fields[key] = value;
  }

  const storePath = fields["StorePath"];
  const url = fields["URL"];
  const compression = fields["Compression"];
  const fileHash = fields["FileHash"];
  const fileSizeStr = fields["FileSize"];
  const narHash = fields["NarHash"];
  const narSizeStr = fields["NarSize"];

  if (!storePath) throw new Error("Missing StorePath");
  if (!url) throw new Error("Missing URL");
  if (!compression) throw new Error("Missing Compression");
  if (!fileHash) throw new Error("Missing FileHash");
  if (fileSizeStr === undefined) throw new Error("Missing FileSize");
  if (!narHash) throw new Error("Missing NarHash");
  if (narSizeStr === undefined) throw new Error("Missing NarSize");

  const fileSize = Number(fileSizeStr);
  if (isNaN(fileSize)) throw new Error(`FileSize is not a number: ${fileSizeStr}`);

  const narSize = Number(narSizeStr);
  if (isNaN(narSize)) throw new Error(`NarSize is not a number: ${narSizeStr}`);

  // StorePath: /nix/store/<hash>-<name> → storeHash は "-" の前まで
  const storeSegment = storePath.split("/").pop() ?? "";
  const dashIdx = storeSegment.indexOf("-");
  const storeHash = dashIdx !== -1 ? storeSegment.slice(0, dashIdx) : storeSegment;

  const narinfoKey = `${storeHash}.narinfo`;
  const narKey = url;

  return {
    storeHash,
    storePath,
    narHash,
    narSize,
    fileHash,
    fileSize,
    compression,
    narinfoKey,
    narKey,
  };
}

/**
 * buildMeta / narinfos / manifest から PublishPayload を組み立てる純粋関数。
 * 各フィールドの形式検証は publish API 側の zod schema（src/schemas/publish.ts）で
 * 行うため、この関数は変換のみ担当する。
 */
export function buildPublishPayload(args: {
  buildMeta: BuildMeta;
  narinfos: NarinfoMeta[];
  manifest: ManifestMeta & {
    host: string;
    system: string;
    gitRev: string;
    flakeLockHash: string;
    toplevelStorePath: string;
  };
}): PublishPayload {
  return {
    build: args.buildMeta,
    storePaths: args.narinfos,
    manifest: args.manifest,
  };
}
