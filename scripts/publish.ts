#!/usr/bin/env bun
/**
 * scripts/publish.ts
 *
 * cf-edgeNix の publish オーケストレーションスクリプト。
 * nix copy が生成したローカル binary cache を R2/D1/KV へ反映する。
 *
 * 実行順序（受入 A2）:
 *   1. closure.json / manifest.json を R2 に put（G5）
 *   2. NAR upload (R2) — HEAD で既存スキップ＋並列 PUT（content-addressed・冪等）
 *   3. narinfo upload (R2) — 並列 PUT
 *   4. D1 確定 (POST /api/publish/{start,ingest,finalize})
 *   5. KV warming (最後・失敗は警告のみ) — KV Bulk API で 1 リクエスト最大 5000 件
 *
 * R2 へは S3 互換 API を直接叩く (UNSIGNED-PAYLOAD で SigV4 署名)。
 * `bunx wrangler` の起動コスト (~1s/回) を排除し、ファイルあたり数十 ms に落とす。
 *
 * 必要な env:
 *   HOST                  対象 nixosConfiguration 名
 *   CACHE_DIR             nix copy の出力先ディレクトリ
 *   TOPLEVEL_STORE_PATH   toplevel store path（publish.sh から渡す）
 *   API_BASE_URL          Worker の URL (例: https://cache.example.com)
 *   ADMIN_TOKEN           管理API の Bearer トークン
 *   CLOUDFLARE_ACCOUNT_ID CF アカウント ID
 *   CLOUDFLARE_API_TOKEN  CF API トークン (KV bulk 書き込み権限)
 *   R2_ACCESS_KEY_ID      R2 S3 互換 API のアクセスキー (R2 dashboard で発行)
 *   R2_SECRET_ACCESS_KEY  R2 S3 互換 API のシークレットキー
 *   R2_BUCKET_NAME        R2 バケット名
 *   KV_NAMESPACE_ID       KV 名前空間 ID
 */

/// <reference types="@types/bun" />
import { readdir, readFile, writeFile } from "fs/promises";
import { resolve, join } from "path";
import { createHash, createHmac } from "crypto";

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
  /** R2 へファイルパスを PUT (NAR / closure.json / manifest.json 等)。 */
  r2Put(bucketName: string, key: string, filePath: string): Promise<void>;
  /** R2 へ文字列コンテンツを PUT (小さなオブジェクト用)。 */
  r2PutContent(bucketName: string, key: string, content: string): Promise<void>;
  /** R2 で key が存在するか確認 (差分化用)。存在すれば true。 */
  r2Has(bucketName: string, key: string): Promise<boolean>;
  /** KV Bulk PUT。items を chunk に切って Cloudflare KV Bulk API へ。 */
  kvPutBulk(
    namespaceId: string,
    items: ReadonlyArray<{ key: string; value: string }>,
  ): Promise<void>;
  /** 管理 API 呼び出し */
  apiPost(url: string, token: string, body: unknown): Promise<unknown>;
}

// ─── AWS SigV4 (R2 S3 互換 API 用) ────────────────────────────────────────────
//
// R2 の S3 互換エンドポイント: https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
// region は "auto"、service は "s3"。署名は AWS SigV4 を流用。
// PUT のペイロードハッシュは UNSIGNED-PAYLOAD を使い、本体は Bun.file の
// ストリームをそのまま流す（メモリに丸ごと載せない）。HEAD/empty body は実ハッシュ。

const R2_REGION = "auto";
const R2_SERVICE = "s3";
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * AWS SigV4 仕様の URI エンコード。RFC3986 unreserved 以外は %XX。
 * encodeSlash=false で path 区切りの "/" は素通し。
 * S3 key に含まれる ":" 等もエンコードされる必要がある (`nar/sha256:foo.nar.zst`)。
 */
function awsUriEncode(s: string, encodeSlash: boolean): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    const isUnreserved =
      (c >= "A" && c <= "Z") ||
      (c >= "a" && c <= "z") ||
      (c >= "0" && c <= "9") ||
      c === "-" ||
      c === "_" ||
      c === "." ||
      c === "~";
    if (isUnreserved) {
      out += c;
      continue;
    }
    if (c === "/" && !encodeSlash) {
      out += "/";
      continue;
    }
    const bytes = Buffer.from(c, "utf8");
    for (const b of bytes) {
      out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

function deriveSigningKey(
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  return hmacSha256(
    hmacSha256(
      hmacSha256(hmacSha256("AWS4" + secret, dateStamp), region),
      service,
    ),
    "aws4_request",
  );
}

interface SignR2Opts {
  method: "GET" | "HEAD" | "PUT";
  accountId: string;
  bucket: string;
  key: string;
  /** body の sha256 hex か "UNSIGNED-PAYLOAD"。 */
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
}

interface SignedR2Request {
  url: string;
  headers: Record<string, string>;
}

function signR2Request(opts: SignR2Opts): SignedR2Request {
  const host = `${opts.accountId}.r2.cloudflarestorage.com`;
  const encodedKey = awsUriEncode(opts.key, false);
  const path = `/${opts.bucket}/${encodedKey}`;
  const url = `https://${host}${path}`;

  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": opts.payloadHash,
    "x-amz-date": amzDate,
  };

  const lowerHeaders: Record<string, string> = {};
  for (const k of Object.keys(headers)) {
    lowerHeaders[k.toLowerCase()] = String(headers[k]).trim().replace(/\s+/g, " ");
  }
  const sortedKeys = Object.keys(lowerHeaders).sort();
  const canonicalHeaders = sortedKeys
    .map((k) => `${k}:${lowerHeaders[k]}\n`)
    .join("");
  const signedHeaders = sortedKeys.join(";");

  const canonicalRequest = [
    opts.method,
    path,
    "",
    canonicalHeaders,
    signedHeaders,
    opts.payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(
    opts.secretAccessKey,
    dateStamp,
    R2_REGION,
    R2_SERVICE,
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url,
    headers: { ...headers, authorization },
  };
}

// ─── fetch アダプタ（本番用） ─────────────────────────────────────────────────

export interface FetchAdapterOpts {
  accountId: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  /** KV Bulk API 用の CF API トークン (KV write 権限)。 */
  cfApiToken: string;
}

/** unknown を安全にメッセージへ変換する (raw error object をログに出さない用)。 */
function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * fetch の指数バックオフ付きリトライ。
 *
 * リトライ対象:
 *   - ネットワーク例外 (fetch 自体の throw)
 *   - HTTP 429 (rate limit)
 *   - HTTP 5xx (一過性のサーバエラー)
 *
 * リトライ非対象 (即返却):
 *   - 2xx / 3xx / 4xx (429 除く)
 *
 * 遅延: 200ms → 800ms → 3200ms (4 回 attempt = 初回 + 3 retry)。
 * 呼び出し側で `Retry-After` を厳密に拾わなくても、合計 ~4.2s のジッタは十分。
 *
 * `build()` をリトライ毎に呼ぶことで、署名 (amzDate) と body (Bun.file 等) を
 * 毎回再生成できる。SigV4 は 15 分有効なので原理上は再利用可能だが、
 * 統一的に再構築した方がストリーム body の再読み込みも含めて安全。
 */
async function fetchWithRetry(
  build: () => { url: string; init: RequestInit },
  opts?: { maxAttempts?: number; baseDelayMs?: number },
): Promise<Response> {
  const maxAttempts = opts?.maxAttempts ?? 4;
  const baseDelayMs = opts?.baseDelayMs ?? 200;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = baseDelayMs * Math.pow(4, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      const { url, init } = build();
      const res = await fetch(url, init);
      const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
      if (!retryable) return res;
      lastErr = new Error(`upstream status ${res.status}`);
      // body を読まずに次の attempt へ (Connection 再利用は実装依存)。
    } catch (e) {
      // ネットワーク例外: e.message のみ保持 (詳細スタックは握り潰す)。
      lastErr = new Error(`fetch failed: ${errMessage(e)}`);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("fetchWithRetry exhausted (no error captured)");
}

/** R2 S3 互換 API + CF KV Bulk API + 管理 API へ fetch で直接送るアダプタ。 */
export function makeFetchAdapter(opts: FetchAdapterOpts): ExecAdapter {
  async function putR2(
    bucket: string,
    key: string,
    bodyFactory: () => Buffer | Blob | Uint8Array | string,
    contentLength?: number,
  ): Promise<void> {
    const res = await fetchWithRetry(() => {
      const signed = signR2Request({
        method: "PUT",
        accountId: opts.accountId,
        bucket,
        key,
        payloadHash: "UNSIGNED-PAYLOAD",
        accessKeyId: opts.r2AccessKeyId,
        secretAccessKey: opts.r2SecretAccessKey,
      });
      const headers: Record<string, string> = { ...signed.headers };
      if (contentLength !== undefined) {
        headers["content-length"] = String(contentLength);
      }
      return {
        url: signed.url,
        init: {
          method: "PUT",
          headers,
          // bodyFactory はリトライ毎に新しい Blob/Buffer を返す。
          body: bodyFactory() as Blob,
        },
      };
    });
    if (!res.ok) {
      // status のみ。詳細レスポンスは秘密値を含み得る。
      throw new Error(`R2 PUT failed (status ${res.status})`);
    }
  }

  return {
    async r2Put(bucket, key, filePath) {
      // size は変わらないので先に取る。body はリトライ毎に新しい Bun.file() を作る。
      const size = Bun.file(filePath).size;
      await putR2(
        bucket,
        key,
        () => Bun.file(filePath) as unknown as Blob,
        size,
      );
    },
    async r2PutContent(bucket, key, content) {
      const buf = Buffer.from(content, "utf8");
      await putR2(bucket, key, () => buf, buf.byteLength);
    },
    async r2Has(bucket, key) {
      const res = await fetchWithRetry(() => {
        const signed = signR2Request({
          method: "HEAD",
          accountId: opts.accountId,
          bucket,
          key,
          payloadHash: EMPTY_SHA256,
          accessKeyId: opts.r2AccessKeyId,
          secretAccessKey: opts.r2SecretAccessKey,
        });
        return {
          url: signed.url,
          init: { method: "HEAD", headers: signed.headers },
        };
      });
      if (res.status === 200) return true;
      if (res.status === 404) return false;
      throw new Error(`R2 HEAD unexpected status ${res.status}`);
    },
    async kvPutBulk(namespaceId, items) {
      if (items.length === 0) return;
      // CF KV Bulk API: 1 リクエスト最大 10000 件 / 100MB。
      // narinfo は数百 B 〜 数 KB / 件なので 5000 件 chunk で安全マージン。
      const CHUNK = 5000;
      const url = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/storage/kv/namespaces/${namespaceId}/bulk`;
      for (let i = 0; i < items.length; i += CHUNK) {
        const chunk = items.slice(i, i + CHUNK);
        const body = JSON.stringify(chunk);
        const res = await fetchWithRetry(() => ({
          url,
          init: {
            method: "PUT",
            headers: {
              authorization: `Bearer ${opts.cfApiToken}`,
              "content-type": "application/json",
            },
            body,
          },
        }));
        if (!res.ok) {
          throw new Error(`KV bulk PUT failed (status ${res.status})`);
        }
      }
    },
    async apiPost(url, token, body) {
      const json = JSON.stringify(body);
      const res = await fetchWithRetry(() => ({
        url,
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: json,
        },
      }));
      if (!res.ok) {
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

/** コンテンツの sha256 ハッシュを "sha256:<hex>" 形式で返す。 */
export function sha256HexPrefixed(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

// 既存 import 互換 (test/publish/publish-script.test.ts が `sha256Hex` を import している)。
export { sha256HexPrefixed as sha256Hex };

// ─── 並列実行ヘルパ ───────────────────────────────────────────────────────────

/**
 * items を concurrency 個のワーカで並列処理する。
 * 1つでも throw すれば即座に reject し、進行中のワーカも止まる。
 */
async function runPool<T>(
  items: ReadonlyArray<T>,
  concurrency: number,
  fn: (item: T, idx: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const workerCount = Math.min(concurrency, items.length);
  let nextIdx = 0;
  let firstError: unknown = null;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (firstError === null) {
          const i = nextIdx++;
          if (i >= items.length) return;
          try {
            await fn(items[i] as T, i);
          } catch (e) {
            if (firstError === null) firstError = e;
            return;
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  if (firstError !== null) throw firstError;
}

// ─── メインロジック ───────────────────────────────────────────────────────────

const D1_INGEST_CHUNK = 50;
const HEAD_CONCURRENCY = 32;
const R2_PUT_CONCURRENCY = 24;

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

  await exec.r2Put(env.r2BucketName, closureJsonKey, closureJsonPath);
  console.log(`[R2] uploaded: ${closureJsonKey}`);

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
  const manifestHash = sha256HexPrefixed(manifestJson);

  // manifest.json を tmp ファイル経由で r2Put (既存テスト契約: r2Put 経由で 2 番目)。
  const manifestTmpPath = resolve(cacheDir, `__manifest_${buildId}.json`);
  await writeFile(manifestTmpPath, manifestJson, "utf-8");
  await exec.r2Put(env.r2BucketName, manifestKey, manifestTmpPath);
  console.log(`[R2] uploaded: ${manifestKey} (hash: ${manifestHash})`);

  // Step 1: NAR upload — HEAD で R2 上の既存を検出してスキップ→不足ぶんを並列 PUT。
  //   NAR は content-addressed (narKey に file hash が入る) なので既存ヒット時の
  //   コンテンツ同一性は保証される。
  const uniqueNarKeys = Array.from(new Set(narinfos.map((ni) => ni.narKey)));

  const missingNarKeys: string[] = [];
  await runPool(uniqueNarKeys, HEAD_CONCURRENCY, async (key) => {
    const exists = await exec.r2Has(env.r2BucketName, key);
    if (!exists) missingNarKeys.push(key);
  });
  console.log(
    `[NAR] ${uniqueNarKeys.length - missingNarKeys.length}/${uniqueNarKeys.length} already on R2, uploading ${missingNarKeys.length}`,
  );

  let narUploaded = 0;
  await runPool(missingNarKeys, R2_PUT_CONCURRENCY, async (key) => {
    const filePath = resolve(cacheDir, key);
    await exec.r2Put(env.r2BucketName, key, filePath);
    narUploaded++;
    if (narUploaded % 50 === 0 || narUploaded === missingNarKeys.length) {
      console.log(`[NAR] uploaded ${narUploaded}/${missingNarKeys.length}`);
    }
  });

  // Step 2: narinfo upload — 並列 PUT。narinfo は署名等で内容が変わり得るので常に上書き。
  let narinfoUploaded = 0;
  await runPool(narinfos, R2_PUT_CONCURRENCY, async (ni) => {
    const filePath = resolve(cacheDir, `${ni.storeHash}.narinfo`);
    await exec.r2Put(env.r2BucketName, ni.narinfoKey, filePath);
    narinfoUploaded++;
    if (narinfoUploaded % 100 === 0 || narinfoUploaded === narinfos.length) {
      console.log(`[narinfo] uploaded ${narinfoUploaded}/${narinfos.length}`);
    }
  });

  const apiBase = env.apiBaseUrl.replace(/\/$/, "");
  const token = env.adminToken;

  // Step 3: D1 確定（start → ingest chunks → finalize）
  const startRes = (await exec.apiPost(
    `${apiBase}/api/publish/start`,
    token,
    { build: buildMeta },
  )) as { build_id: string };
  const confirmedBuildId = startRes.build_id;
  console.log(`[D1] build started: ${confirmedBuildId}`);

  for (let i = 0; i < narinfos.length; i += D1_INGEST_CHUNK) {
    const chunk = narinfos.slice(i, i + D1_INGEST_CHUNK);
    await exec.apiPost(
      `${apiBase}/api/publish/${confirmedBuildId}/ingest`,
      token,
      { storePaths: chunk },
    );
  }
  console.log(`[D1] ingested ${narinfos.length} store paths`);

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

  // Step 4: KV warming — 全件を bulk API で 1〜数リクエストにまとめる。失敗は警告のみ。
  try {
    const items: Array<{ key: string; value: string }> = [];
    for (const ni of narinfos) {
      const content = await readFile(
        resolve(cacheDir, `${ni.storeHash}.narinfo`),
        "utf-8",
      );
      items.push({ key: `narinfo:${ni.storeHash}`, value: content });
    }
    await exec.kvPutBulk(env.kvNamespaceId, items);
    console.log(`[KV] warming complete (${items.length} entries)`);
  } catch (e) {
    // raw error は request detail を含み得るので message のみログ出力。
    console.warn(`[KV] warming failed (non-fatal): ${errMessage(e)}`);
  }
}

// ─── エントリポイント ─────────────────────────────────────────────────────────

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
  const toplevelStorePath = process.env["TOPLEVEL_STORE_PATH"];

  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  const cfApiToken = process.env["CLOUDFLARE_API_TOKEN"];
  const r2AccessKeyId = process.env["R2_ACCESS_KEY_ID"];
  const r2SecretAccessKey = process.env["R2_SECRET_ACCESS_KEY"];

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

  if (!accountId || !cfApiToken || !r2AccessKeyId || !r2SecretAccessKey) {
    console.error(
      "Missing required env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY",
    );
    process.exit(1);
  }

  // build_id は決定的に生成 (修正6)。
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

  const adapter = makeFetchAdapter({
    accountId,
    r2AccessKeyId,
    r2SecretAccessKey,
    cfApiToken,
  });

  publish(
    cacheDir,
    buildMeta,
    { apiBaseUrl, adminToken, r2BucketName, kvNamespaceId },
    adapter,
  )
    .then(() => {
      console.log("publish complete");
    })
    .catch((e: unknown) => {
      console.error(`publish failed: ${errMessage(e)}`);
      process.exit(1);
    });
}
