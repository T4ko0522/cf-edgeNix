#!/usr/bin/env bun
/**
 * scripts/publish.ts
 *
 * cf-edgeNix の publish オーケストレーションスクリプト。
 * nix copy が生成したローカル binary cache を R2/D1/KV へ反映する。
 *
 * 実行順序（受入 A2）:
 *   1. closure.json / manifest.json を R2 に put（G5）
 *   2. NAR upload (R2) — 既存はスキップ（冪等・G5）
 *   3. narinfo upload (R2)
 *   4. D1 確定 (POST /api/publish/{start,ingest,finalize})
 *   5. KV warming (最後・失敗は警告のみ)
 *
 * 必要な env:
 *   HOST                  対象 nixosConfiguration 名
 *   CACHE_DIR             nix copy の出力先ディレクトリ
 *   TOPLEVEL_STORE_PATH   toplevel store path（publish.sh から渡す）
 *   API_BASE_URL          Worker の URL (例: https://cache.example.com)
 *   ADMIN_TOKEN           管理API の Bearer トークン
 *   CLOUDFLARE_ACCOUNT_ID CF アカウント ID (wrangler 用)
 *   CLOUDFLARE_API_TOKEN  CF API トークン (R2 write / KV write 最小権限)
 *   R2_BUCKET_NAME        R2 バケット名
 *   KV_NAMESPACE_ID       KV 名前空間 ID
 *
 * wrangler CLI 呼び出しは exec アダプタに隔離（テスト時モック可能）。
 */

/// <reference types="@types/bun" />
import { readdir, readFile, writeFile, unlink } from "fs/promises";
import { resolve, join } from "path";
import { createHash } from "crypto";
import { tmpdir } from "os";

// ─── 型定義 ───────────────────────────────────────────────────────────────────

export interface NarinfoMeta {
  storeHash: string;
  storePath: string;
  narHash: string;
  narSize: number;
  fileHash: string;
  fileSize: number;
  compression: string;
  narinfoKey: string;
  narKey: string;
}

export interface BuildMeta {
  id: string;
  host: string;
  system: string;
  gitRev: string;
  flakeLockHash: string;
  toplevelStorePath: string;
  createdAt: number;
}

export interface ManifestMeta {
  closureJsonKey: string;
  manifestKey: string;
  manifestHash: string;
  host: string;
  system: string;
  gitRev: string;
  flakeLockHash: string;
  toplevelStorePath: string;
}

// ─── exec アダプタ（テスト時モック可能） ─────────────────────────────────────

export interface ExecAdapter {
  /** wrangler r2 object put (ファイルパス指定) */
  r2Put(bucketName: string, key: string, filePath: string): Promise<void>;
  /** wrangler r2 object put (文字列コンテンツを stdin --pipe 経由) */
  r2PutContent(bucketName: string, key: string, content: string): Promise<void>;
  /** wrangler kv key put (一時ファイル --path 経由・value を argv に露出しない) */
  kvPut(namespaceId: string, key: string, value: string): Promise<void>;
  /** 管理 API 呼び出し */
  apiPost(url: string, token: string, body: unknown): Promise<unknown>;
}

/**
 * 実際の wrangler CLI を使う exec アダプタ。
 * CF token / account ID は環境変数から取得。
 */
export function makeWranglerAdapter(): ExecAdapter {
  const spawn = async (cmd: string[]): Promise<{ stdout: string; exitCode: number; stderr: string }> => {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  };

  const spawnOrThrow = async (cmd: string[], opts?: { stdin?: string }): Promise<string> => {
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: opts?.stdin !== undefined ? "pipe" : "inherit",
    });
    if (opts?.stdin !== undefined && proc.stdin) {
      // Bun FileSink: write + flush + end でストリームを閉じる。
      proc.stdin.write(opts.stdin);
      await proc.stdin.flush();
      proc.stdin.end();
    }
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      // コマンド全文・秘密値・内部パスを含めない（修正13）。
      throw new Error(`wrangler command failed (exit ${exitCode})`);
    }
    void stderr;
    return stdout;
  };

  return {
    async r2Put(bucketName, key, filePath) {
      await spawnOrThrow([
        "bunx", "wrangler", "r2", "object", "put",
        `${bucketName}/${key}`,
        "--file", filePath,
      ]);
    },
    async r2PutContent(bucketName, key, content) {
      // content を stdin (--pipe) 経由で wrangler に渡す。
      // `wrangler r2 object put --pipe` は put に存在するフラグ（実機確認済み）。
      await spawnOrThrow([
        "bunx", "wrangler", "r2", "object", "put",
        `${bucketName}/${key}`,
        "--pipe",
      ], { stdin: content });
    },
    async kvPut(namespaceId, key, value) {
      // value を argv に載せない（security 指摘対応）。
      // `wrangler kv key put --stdin` は存在しない（実機確認済み）。
      // `--path <tempfile>` 経由で渡す。パーミッション 600・使用後に確実に削除。
      const tmpPath = join(tmpdir(), `kv-put-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      try {
        await writeFile(tmpPath, value, { encoding: "utf-8", mode: 0o600 });
        await spawnOrThrow([
          "bunx", "wrangler", "kv", "key", "put",
          "--namespace-id", namespaceId,
          "--path", tmpPath,
          key,
        ]);
      } finally {
        await unlink(tmpPath).catch(() => {});
      }
    },
    async apiPost(url, token, body) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // 内部 message/スタックを含めない（修正13）。
        throw new Error(`API POST failed: ${res.status}`);
      }
      return res.json();
    },
  };
}

// ─── narinfo パーサ ───────────────────────────────────────────────────────────

export function parseNarinfo(text: string): NarinfoMeta {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) fields[k] = v;
  }

  const storePath = fields["StorePath"];
  const url = fields["URL"];
  const compression = fields["Compression"];
  const fileHash = fields["FileHash"];
  const fileSizeStr = fields["FileSize"];
  const narHash = fields["NarHash"];
  const narSizeStr = fields["NarSize"];

  if (!storePath || !url || !compression || !fileHash || !fileSizeStr || !narHash || !narSizeStr) {
    throw new Error(`Missing required narinfo fields`);
  }

  const fileSize = Number(fileSizeStr);
  const narSize = Number(narSizeStr);
  if (isNaN(fileSize) || isNaN(narSize)) {
    throw new Error(`Invalid numeric fields in narinfo`);
  }

  const seg = storePath.split("/").pop() ?? "";
  const dash = seg.indexOf("-");
  const storeHash = dash !== -1 ? seg.slice(0, dash) : seg;

  return {
    storeHash,
    storePath,
    narHash,
    narSize,
    fileHash,
    fileSize,
    compression,
    narinfoKey: `${storeHash}.narinfo`,
    narKey: url,
  };
}

// ─── manifest.json 生成 ───────────────────────────────────────────────────────

export function buildManifestJson(args: {
  buildId: string;
  host: string;
  system: string;
  gitRev: string;
  flakeLockHash: string;
  toplevelStorePath: string;
  narinfos: NarinfoMeta[];
  closureJsonKey: string;
}): string {
  return JSON.stringify({
    buildId: args.buildId,
    host: args.host,
    system: args.system,
    gitRev: args.gitRev,
    flakeLockHash: args.flakeLockHash,
    toplevelStorePath: args.toplevelStorePath,
    storePaths: args.narinfos.map((ni) => ({
      storeHash: ni.storeHash,
      storePath: ni.storePath,
      narKey: ni.narKey,
      narinfoKey: ni.narinfoKey,
    })),
    closureJsonKey: args.closureJsonKey,
  });
}

/**
 * コンテンツの sha256 ハッシュを "sha256:<hex>" 形式で返す。
 */
export function sha256Hex(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

// ─── R2 アップロードヘルパ ────────────────────────────────────────────────────
// r2Head / r2PutIfAbsent は削除。
// NAR は content-addressed かつ wrangler r2 object put が上書き安全（idempotent）
// のため、常に put する方針（A5: 上書き安全で充足）。
// 将来の最適化として存在チェックを追加する場合は、CF Worker に R2 binding を使う
// HEAD エンドポイント、または S3 互換 API の HEAD を検討すること（wrangler CLI に
// `r2 object head` サブコマンドも `get --range` フラグも存在しないため CLI では不可）。

// ─── メインロジック ───────────────────────────────────────────────────────────

const CHUNK_SIZE = 50;

export async function publish(
  cacheDir: string,
  buildMeta: BuildMeta,
  env: {
    apiBaseUrl: string;
    adminToken: string;
    r2BucketName: string;
    kvNamespaceId: string;
  },
  exec: ExecAdapter,
): Promise<void> {
  // narinfo ファイルを列挙・パース
  const files = await readdir(cacheDir);
  const narinfoFiles = files.filter((f) => f.endsWith(".narinfo"));

  const narinfos: NarinfoMeta[] = [];
  for (const f of narinfoFiles) {
    const text = await readFile(join(cacheDir, f), "utf-8");
    narinfos.push(parseNarinfo(text));
  }

  const buildId = buildMeta.id;

  // Step 0: closure.json / manifest.json を R2 に put（G5）
  const closureJsonPath = resolve(process.cwd(), "closure.json");
  const closureJsonKey = `manifests/${buildId}/closure.json`;
  const manifestKey = `manifests/${buildId}/manifest.json`;

  // closure.json をアップロード
  await exec.r2Put(env.r2BucketName, closureJsonKey, closureJsonPath);
  console.log(`[R2] uploaded: ${closureJsonKey}`);

  // manifest.json を生成してアップロード（実ハッシュを計算・G5）
  const manifestJson = buildManifestJson({
    buildId,
    host: buildMeta.host,
    system: buildMeta.system,
    gitRev: buildMeta.gitRev,
    flakeLockHash: buildMeta.flakeLockHash,
    toplevelStorePath: buildMeta.toplevelStorePath,
    narinfos,
    closureJsonKey,
  });
  const manifestHash = sha256Hex(manifestJson);

  // manifest.json を一時ファイルに書いてアップロード
  const manifestTmpPath = resolve(cacheDir, `__manifest_${buildId}.json`);
  await writeFile(manifestTmpPath, manifestJson, "utf-8");
  await exec.r2Put(env.r2BucketName, manifestKey, manifestTmpPath);
  console.log(`[R2] uploaded: ${manifestKey} (hash: ${manifestHash})`);

  // Step 1: NAR upload（content-addressed・wrangler r2 put は上書き安全・A5 充足）
  // r2Head による存在チェックは撤去（wrangler CLI に head/range フラグが存在しない）。
  // 同一 narKey の重複投入を避けるため Set でキー管理し、1 put/unique-key とする。
  const uploadedNarKeys = new Set<string>();
  for (const ni of narinfos) {
    if (!uploadedNarKeys.has(ni.narKey)) {
      const filePath = resolve(cacheDir, ni.narKey);
      await exec.r2Put(env.r2BucketName, ni.narKey, filePath);
      uploadedNarKeys.add(ni.narKey);
      console.log(`[NAR] uploaded: ${ni.narKey}`);
    }
  }

  // Step 2: narinfo upload
  for (const ni of narinfos) {
    const filePath = resolve(cacheDir, `${ni.storeHash}.narinfo`);
    await exec.r2Put(env.r2BucketName, ni.narinfoKey, filePath);
    console.log(`[narinfo] uploaded: ${ni.narinfoKey}`);
  }

  const apiBase = env.apiBaseUrl.replace(/\/$/, "");
  const token = env.adminToken;

  // Step 3: D1 確定（start → ingest chunks → finalize）
  const startRes = await exec.apiPost(
    `${apiBase}/api/publish/start`,
    token,
    { build: buildMeta },
  ) as { build_id: string };
  const confirmedBuildId = startRes.build_id;
  console.log(`[D1] build started: ${confirmedBuildId}`);

  for (let i = 0; i < narinfos.length; i += CHUNK_SIZE) {
    const chunk = narinfos.slice(i, i + CHUNK_SIZE);
    await exec.apiPost(
      `${apiBase}/api/publish/${confirmedBuildId}/ingest`,
      token,
      { storePaths: chunk },
    );
    console.log(`[D1] ingested chunk ${Math.floor(i / CHUNK_SIZE) + 1}`);
  }

  const manifestMeta: ManifestMeta = {
    closureJsonKey,
    manifestKey,
    manifestHash,
    host: buildMeta.host,
    system: buildMeta.system,
    gitRev: buildMeta.gitRev,
    flakeLockHash: buildMeta.flakeLockHash,
    toplevelStorePath: buildMeta.toplevelStorePath,
  };

  await exec.apiPost(
    `${apiBase}/api/publish/${confirmedBuildId}/finalize`,
    token,
    { manifest: manifestMeta },
  );
  console.log(`[D1] finalized: ${confirmedBuildId}`);

  // Step 4: KV warming（失敗は警告のみ）
  try {
    for (const ni of narinfos) {
      const content = await readFile(resolve(cacheDir, `${ni.storeHash}.narinfo`), "utf-8");
      await exec.kvPut(env.kvNamespaceId, `narinfo:${ni.storeHash}`, content);
    }
    console.log(`[KV] warming complete`);
  } catch (e) {
    console.warn(`[KV] warming failed (non-fatal):`, e);
  }
}

// ─── エントリポイント ─────────────────────────────────────────────────────────
// import.meta.filename === process.argv[1] のとき（直接実行）のみ実行する。
// vitest でインポートされるときはこのブロックをスキップする。

if (
  typeof process !== "undefined" &&
  typeof process.argv[1] !== "undefined" &&
  import.meta.filename === process.argv[1]
) {
  const host = process.env["HOST"];
  const cacheDir = process.env["CACHE_DIR"];
  const apiBaseUrl = process.env["API_BASE_URL"];
  const adminToken = process.env["ADMIN_TOKEN"];
  const r2BucketName = process.env["R2_BUCKET_NAME"];
  const kvNamespaceId = process.env["KV_NAMESPACE_ID"];
  const gitRev = process.env["GIT_REV"] ?? "unknown";
  const system = process.env["SYSTEM"] ?? "x86_64-linux";
  const flakeLockHash = process.env["FLAKE_LOCK_HASH"] ?? "unknown";
  // publish.sh が出力した toplevel store path（実値・G5）
  const toplevelStorePath = process.env["TOPLEVEL_STORE_PATH"];

  if (!host || !cacheDir || !apiBaseUrl || !adminToken || !r2BucketName || !kvNamespaceId) {
    console.error(
      "Missing required env: HOST, CACHE_DIR, API_BASE_URL, ADMIN_TOKEN, R2_BUCKET_NAME, KV_NAMESPACE_ID",
    );
    process.exit(1);
  }

  if (!toplevelStorePath) {
    console.error("Missing required env: TOPLEVEL_STORE_PATH (set by publish.sh)");
    process.exit(1);
  }

  // build_id は決定的に生成（host + system + gitRev + flakeLockHash + toplevelStorePath から SHA256）。
  // system と toplevelStorePath を含めることで意味的衝突を検出できる（修正6）。
  const buildIdInput = `${host}:${system}:${gitRev}:${flakeLockHash}:${toplevelStorePath}`;
  const buildId = createHash("sha256").update(buildIdInput).digest("hex").slice(0, 36);

  const buildMeta: BuildMeta = {
    id: buildId,
    host,
    system,
    gitRev,
    flakeLockHash,
    toplevelStorePath,
    createdAt: Date.now(),
  };

  publish(cacheDir, buildMeta, { apiBaseUrl, adminToken, r2BucketName, kvNamespaceId }, makeWranglerAdapter())
    .then(() => {
      console.log("publish complete");
    })
    .catch((e: unknown) => {
      console.error("publish failed:", e);
      process.exit(1);
    });
}
