#!/usr/bin/env bun
/**
 * scripts/publish.ts
 *
 * cf-edgeNix の publish オーケストレーションスクリプト。
 * 分類後に生成した所有pathのNAR/narinfoを R2/D1/KV へ反映する。
 *
 * batch 実行順序:
 *   1. 全 host の D1 start / ingest
 *   2. host 別 closure.json / manifest.json
 *   3. NAR upload（全 host の和集合、narKey で重複排除）
 *   4. narinfo upload（storeHash で重複排除）
 *   5. host 別 finalize
 *   6. KV warming（和集合に対して一度、失敗は警告のみ）
 *
 * R2 へは S3 互換 API を直接叩く (UNSIGNED-PAYLOAD で SigV4 署名)。
 * `bunx wrangler` の起動コスト (~1s/回) を排除し、ファイルあたり数十 ms に落とす。
 *
 * CLI:
 *   --plan <path>         秘密情報を含まない version 2 publish plan
 *
 * 必要な env:
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
import { readdir, readFile } from "fs/promises";
import { isAbsolute, resolve, join } from "path";
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

export interface PublishPlanTarget {
  host: string;
  system: string;
  gitRev: string;
  flakeLockHash: string;
  toplevelStorePath: string;
  closureJsonPath: string;
  closureStorePaths: string[];
  externalStorePaths: Array<{ storePath: string; substituterUrl: string }>;
  selfExistingStorePaths: string[];
  newStorePaths: string[];
}

export interface PublishPlan {
  version: 2;
  cacheDir: string;
  selfNarinfoDir: string;
  targets: PublishPlanTarget[];
}

export interface PublishEnv {
  apiBaseUrl: string;
  adminToken: string;
  r2BucketName: string;
  kvNamespaceId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlyArray<string>,
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}`);
  }
}

export function parsePublishPlan(value: unknown): PublishPlan {
  if (!isRecord(value)) throw new Error("publish plan must be an object");
  assertExactKeys(value, ["version", "cacheDir", "selfNarinfoDir", "targets"], "publish plan");
  if (value["version"] !== 2) throw new Error("publish plan version must be 2");
  const cacheDir = requiredString(value["cacheDir"], "cacheDir");
  if (!isAbsolute(cacheDir)) throw new Error("cacheDir must be absolute");
  const selfNarinfoDir = requiredString(value["selfNarinfoDir"], "selfNarinfoDir");
  if (!isAbsolute(selfNarinfoDir)) throw new Error("selfNarinfoDir must be absolute");
  if (!Array.isArray(value["targets"]) || value["targets"].length === 0) {
    throw new Error("targets must be a non-empty array");
  }

  const hosts = new Set<string>();
  const targets = value["targets"].map((raw, index): PublishPlanTarget => {
    if (!isRecord(raw)) throw new Error(`targets[${index}] must be an object`);
    assertExactKeys(raw, [
      "host", "system", "gitRev", "flakeLockHash", "toplevelStorePath",
      "closureJsonPath", "closureStorePaths", "externalStorePaths",
      "selfExistingStorePaths", "newStorePaths",
    ], `targets[${index}]`);
    const host = requiredString(raw["host"], `targets[${index}].host`);
    if (!/^[A-Za-z0-9._-]+$/.test(host)) {
      throw new Error(`targets[${index}].host is invalid`);
    }
    if (hosts.has(host)) throw new Error(`duplicate host: ${host}`);
    hosts.add(host);

    const toplevelStorePath = requiredString(raw["toplevelStorePath"], `targets[${index}].toplevelStorePath`);
    if (!toplevelStorePath.startsWith("/nix/store/")) {
      throw new Error(`targets[${index}].toplevelStorePath must be a Nix store path`);
    }
    const closureJsonPath = requiredString(raw["closureJsonPath"], `targets[${index}].closureJsonPath`);
    if (!isAbsolute(closureJsonPath)) {
      throw new Error(`targets[${index}].closureJsonPath must be absolute`);
    }
    if (!Array.isArray(raw["closureStorePaths"])) {
      throw new Error(`targets[${index}].closureStorePaths must be an array`);
    }
    const closureStorePaths = raw["closureStorePaths"].map((path, pathIndex) => {
      const parsed = requiredString(path, `targets[${index}].closureStorePaths[${pathIndex}]`);
      if (!parsed.startsWith("/nix/store/")) {
        throw new Error(`targets[${index}].closureStorePaths[${pathIndex}] must be a Nix store path`);
      }
      return parsed;
    });
    if (new Set(closureStorePaths).size !== closureStorePaths.length) {
      throw new Error(`targets[${index}].closureStorePaths contains duplicates`);
    }
    const parsePaths = (key: "selfExistingStorePaths" | "newStorePaths"): string[] => {
      const input = raw[key];
      if (!Array.isArray(input)) throw new Error(`targets[${index}].${key} must be an array`);
      return input.map((path, pathIndex) => {
        const parsed = requiredString(path, `targets[${index}].${key}[${pathIndex}]`);
        if (!parsed.startsWith("/nix/store/")) throw new Error(`${key} must contain Nix store paths`);
        return parsed;
      });
    };
    if (!Array.isArray(raw["externalStorePaths"])) {
      throw new Error(`targets[${index}].externalStorePaths must be an array`);
    }
    const externalStorePaths = raw["externalStorePaths"].map((entry, entryIndex) => {
      if (!isRecord(entry)) throw new Error(`externalStorePaths[${entryIndex}] must be an object`);
      assertExactKeys(entry, ["storePath", "substituterUrl"], `externalStorePaths[${entryIndex}]`);
      const storePath = requiredString(entry["storePath"], "external storePath");
      const substituterUrl = requiredString(entry["substituterUrl"], "substituterUrl");
      if (!storePath.startsWith("/nix/store/") || !/^https?:\/\//.test(substituterUrl)) {
        throw new Error("external entry must have a Nix store path and HTTP(S) substituter");
      }
      return { storePath, substituterUrl };
    });
    const selfExistingStorePaths = parsePaths("selfExistingStorePaths");
    const newStorePaths = parsePaths("newStorePaths");
    const classified = [
      ...externalStorePaths.map((entry) => entry.storePath),
      ...selfExistingStorePaths,
      ...newStorePaths,
    ];
    if (classified.length !== closureStorePaths.length ||
        new Set(classified).size !== classified.length ||
        classified.some((path) => !closureStorePaths.includes(path))) {
      throw new Error(`targets[${index}] classification must partition the full closure`);
    }
    const system = requiredString(raw["system"], `targets[${index}].system`);
    const gitRev = requiredString(raw["gitRev"], `targets[${index}].gitRev`);
    const flakeLockHash = requiredString(raw["flakeLockHash"], `targets[${index}].flakeLockHash`);
    if (system.length > 64 || gitRev.length > 512 || flakeLockHash.length > 512) {
      throw new Error(`targets[${index}] metadata exceeds API limits`);
    }
    return {
      host,
      system,
      gitRev,
      flakeLockHash,
      toplevelStorePath,
      closureJsonPath,
      closureStorePaths,
      externalStorePaths,
      selfExistingStorePaths,
      newStorePaths,
    };
  });
  return { version: 2, cacheDir, selfNarinfoDir, targets };
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
        // レスポンス body は Worker 自身が返す構造化エラー ({ error, conflictingStoreHash? })
        // であり、CI 側で衝突原因を特定するために必要。stderr/スタック等は含まない。
        const raw = await res.text().catch(() => "");
        const detail = raw ? ` — ${raw.slice(0, 2048)}` : "";
        throw new Error(`API POST failed: ${res.status}${detail}`);
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
  externalStorePaths: Array<{ storePath: string; substituterUrl: string }>;
  closureJsonKey: string;
}): string {
  return JSON.stringify({
    version: 2,
    buildId: args.buildId,
    host: args.host,
    system: args.system,
    gitRev: args.gitRev,
    flakeLockHash: args.flakeLockHash,
    toplevelStorePath: args.toplevelStorePath,
    closure: {
      owned: args.narinfos.map((ni) => ({
        storeHash: ni.storeHash,
        storePath: ni.storePath,
        narKey: ni.narKey,
        narinfoKey: ni.narinfoKey,
      })),
      external: args.externalStorePaths,
    },
    closureJsonKey: args.closureJsonKey,
  });
}

/** コンテンツの sha256 ハッシュを "sha256:<hex>" 形式で返す。 */
export function sha256HexPrefixed(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

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

const D1_INGEST_CHUNK = 15;
const HEAD_CONCURRENCY = 32;
const R2_PUT_CONCURRENCY = 24;

function buildIdFor(target: PublishPlanTarget): string {
  // A staging retry with a different external/owned boundary must not inherit
  // stale build_closure rows from the previous attempt.
  const input = JSON.stringify({
    host: target.host,
    system: target.system,
    gitRev: target.gitRev,
    flakeLockHash: target.flakeLockHash,
    toplevelStorePath: target.toplevelStorePath,
    closureStorePaths: [...target.closureStorePaths].sort(),
    externalStorePaths: [...target.externalStorePaths].sort((a, b) =>
      a.storePath.localeCompare(b.storePath) || a.substituterUrl.localeCompare(b.substituterUrl)),
  });
  return createHash("sha256").update(input).digest("hex").slice(0, 36);
}

async function readCacheNarinfos(cacheDir: string): Promise<NarinfoMeta[]> {
  const files = await readdir(cacheDir);
  const narinfos: NarinfoMeta[] = [];
  for (const file of files.filter((name) => name.endsWith(".narinfo")).sort()) {
    narinfos.push(parseNarinfo(await readFile(join(cacheDir, file), "utf-8")));
  }
  return narinfos;
}

export async function publishBatch(
  plan: PublishPlan,
  env: PublishEnv,
  exec: ExecAdapter,
): Promise<void> {
  const newNarinfos = await readCacheNarinfos(plan.cacheDir);
  const selfNarinfos = await readCacheNarinfos(plan.selfNarinfoDir);
  const narinfos = [...newNarinfos, ...selfNarinfos];
  const newPaths = new Set(plan.targets.flatMap((target) => target.newStorePaths));
  const selfPaths = new Set(plan.targets.flatMap((target) => target.selfExistingStorePaths));
  const expectedOwned = new Set([...newPaths, ...selfPaths]);
  if (narinfos.length !== expectedOwned.size ||
      narinfos.some((narinfo) => !expectedOwned.has(narinfo.storePath)) ||
      newNarinfos.some((narinfo) => !newPaths.has(narinfo.storePath)) ||
      selfNarinfos.some((narinfo) => !selfPaths.has(narinfo.storePath))) {
    throw new Error("narinfo files do not match classified owned paths");
  }
  const narinfoByStorePath = new Map<string, NarinfoMeta>();
  const narinfoByStoreHash = new Map<string, NarinfoMeta>();
  for (const narinfo of narinfos) {
    if (narinfoByStorePath.has(narinfo.storePath)) {
      throw new Error(`duplicate narinfo StorePath: ${narinfo.storePath}`);
    }
    const sameHash = narinfoByStoreHash.get(narinfo.storeHash);
    if (sameHash && sameHash.storePath !== narinfo.storePath) {
      throw new Error(`conflicting narinfo storeHash: ${narinfo.storeHash}`);
    }
    narinfoByStorePath.set(narinfo.storePath, narinfo);
    narinfoByStoreHash.set(narinfo.storeHash, narinfo);
  }

  const createdAt = Date.now();
  const targets = plan.targets.map((target) => {
    const buildMeta: BuildMeta = {
      id: buildIdFor(target),
      host: target.host,
      system: target.system,
      gitRev: target.gitRev,
      flakeLockHash: target.flakeLockHash,
      toplevelStorePath: target.toplevelStorePath,
      createdAt,
    };
    const targetNarinfos = target.closureStorePaths.flatMap((storePath) => {
      const narinfo = narinfoByStorePath.get(storePath);
      return narinfo ? [narinfo] : [];
    });
    return { target, buildMeta, narinfos: targetNarinfos, confirmedBuildId: "" };
  });

  const apiBase = env.apiBaseUrl.replace(/\/$/, "");
  for (const state of targets) {
    const start = (await exec.apiPost(
      `${apiBase}/api/publish/start`,
      env.adminToken,
      { build: state.buildMeta },
    )) as { build_id: string };
    state.confirmedBuildId = start.build_id;
    for (let i = 0; i < state.narinfos.length; i += D1_INGEST_CHUNK) {
      await exec.apiPost(
        `${apiBase}/api/publish/${state.confirmedBuildId}/ingest`,
        env.adminToken,
        { storePaths: state.narinfos.slice(i, i + D1_INGEST_CHUNK) },
      );
    }
  }

  const manifests = new Map<string, ManifestMeta>();
  for (const state of targets) {
    const buildId = state.buildMeta.id;
    const closureJsonKey = `manifests/${buildId}/closure.json`;
    const manifestKey = `manifests/${buildId}/manifest.json`;
    await exec.r2Put(env.r2BucketName, closureJsonKey, state.target.closureJsonPath);
    const manifestJson = buildManifestJson({
      buildId,
      host: state.buildMeta.host,
      system: state.buildMeta.system,
      gitRev: state.buildMeta.gitRev,
      flakeLockHash: state.buildMeta.flakeLockHash,
      toplevelStorePath: state.buildMeta.toplevelStorePath,
      narinfos: state.narinfos,
      externalStorePaths: state.target.externalStorePaths,
      closureJsonKey,
    });
    await exec.r2PutContent(env.r2BucketName, manifestKey, manifestJson);
    manifests.set(buildId, {
      closureJsonKey,
      manifestKey,
      manifestHash: sha256HexPrefixed(manifestJson),
      host: state.buildMeta.host,
      system: state.buildMeta.system,
      gitRev: state.buildMeta.gitRev,
      flakeLockHash: state.buildMeta.flakeLockHash,
      toplevelStorePath: state.buildMeta.toplevelStorePath,
    });
  }

  const uploadNarinfos = new Map<string, NarinfoMeta>();
  const ownedNarinfos = new Map<string, NarinfoMeta>();
  for (const state of targets) {
    for (const narinfo of state.narinfos) {
      ownedNarinfos.set(narinfo.storeHash, narinfo);
      if (newPaths.has(narinfo.storePath)) uploadNarinfos.set(narinfo.storeHash, narinfo);
    }
  }
  const uniqueNarKeys = new Set(narinfos.map((narinfo) => narinfo.narKey));
  const missingNarKeys: string[] = [];
  await runPool([...uniqueNarKeys], HEAD_CONCURRENCY, async (key) => {
    if (!(await exec.r2Has(env.r2BucketName, key))) missingNarKeys.push(key);
  });
  const uploadableNarKeys = new Set([...uploadNarinfos.values()].map((narinfo) => narinfo.narKey));
  const missingSelfNarKey = missingNarKeys.find((key) => !uploadableNarKeys.has(key));
  if (missingSelfNarKey) throw new Error(`self-existing NAR missing from R2: ${missingSelfNarKey}`);
  await runPool(missingNarKeys, R2_PUT_CONCURRENCY, async (key) => {
    await exec.r2Put(env.r2BucketName, key, resolve(plan.cacheDir, key));
  });
  await runPool([...ownedNarinfos.values()], R2_PUT_CONCURRENCY, async (narinfo) => {
    const narinfoDir = newPaths.has(narinfo.storePath) ? plan.cacheDir : plan.selfNarinfoDir;
    await exec.r2Put(
      env.r2BucketName,
      narinfo.narinfoKey,
      resolve(narinfoDir, `${narinfo.storeHash}.narinfo`),
    );
  });

  for (const state of targets) {
    await exec.apiPost(
      `${apiBase}/api/publish/${state.confirmedBuildId}/finalize`,
      env.adminToken,
      { manifest: manifests.get(state.buildMeta.id) },
    );
  }

  try {
    const items: Array<{ key: string; value: string }> = [];
    for (const narinfo of ownedNarinfos.values()) {
      const narinfoDir = newPaths.has(narinfo.storePath) ? plan.cacheDir : plan.selfNarinfoDir;
      items.push({
        key: `narinfo:${narinfo.storeHash}`,
        value: await readFile(resolve(narinfoDir, `${narinfo.storeHash}.narinfo`), "utf-8"),
      });
    }
    await exec.kvPutBulk(env.kvNamespaceId, items);
  } catch (e) {
    console.warn(`[KV] warming failed (non-fatal): ${errMessage(e)}`);
  }
}

// ─── エントリポイント ─────────────────────────────────────────────────────────

if (
  typeof process !== "undefined" &&
  typeof process.argv[1] !== "undefined" &&
  import.meta.filename === process.argv[1]
) {
  const planFlag = process.argv[2];
  const planPath = process.argv[3];
  const apiBaseUrl = process.env["API_BASE_URL"];
  const adminToken = process.env["ADMIN_TOKEN"];
  const r2BucketName = process.env["R2_BUCKET_NAME"];
  const kvNamespaceId = process.env["KV_NAMESPACE_ID"];
  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  const cfApiToken = process.env["CLOUDFLARE_API_TOKEN"];
  const r2AccessKeyId = process.env["R2_ACCESS_KEY_ID"];
  const r2SecretAccessKey = process.env["R2_SECRET_ACCESS_KEY"];

  if (planFlag !== "--plan" || !planPath) {
    console.error("Usage: bun scripts/publish.ts --plan <plan.json>");
    process.exit(1);
  }

  if (!apiBaseUrl || !adminToken || !r2BucketName || !kvNamespaceId) {
    console.error(
      "Missing required env: API_BASE_URL, ADMIN_TOKEN, R2_BUCKET_NAME, KV_NAMESPACE_ID",
    );
    process.exit(1);
  }

  if (!accountId || !cfApiToken || !r2AccessKeyId || !r2SecretAccessKey) {
    console.error(
      "Missing required env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY",
    );
    process.exit(1);
  }

  const adapter = makeFetchAdapter({
    accountId,
    r2AccessKeyId,
    r2SecretAccessKey,
    cfApiToken,
  });

  readFile(planPath, "utf-8")
    .then((content) => parsePublishPlan(JSON.parse(content) as unknown))
    .then((plan) => publishBatch(
      plan,
      { apiBaseUrl, adminToken, r2BucketName, kvNamespaceId },
      adapter,
    ))
    .then(() => {
      console.log("publish complete");
    })
    .catch((e: unknown) => {
      console.error(`publish failed: ${errMessage(e)}`);
      process.exit(1);
    });
}
