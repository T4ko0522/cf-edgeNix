/**
 * test/integration/cache-headers.test.ts
 *
 * Workers Cache 導入に伴うレスポンスヘッダ契約の統合テスト。
 * Workers Cache は Worker の手前でレスポンスヘッダ（Cache-Control / Cache-Tag）に
 * 従ってキャッシュするため、「Worker が正しいヘッダを返すこと」が契約になる。
 * edge 側のキャッシュ挙動そのものはデプロイ後検証（miniflare は対象外）。
 *
 * 検証内容:
 * - narinfo 200: max-age=3600 + Cache-Tag narinfo,narinfo:<storeHash>
 * - narinfo 404: negative cache（max-age=60）+ Cache-Tag narinfo-miss,narinfo:<storeHash>
 * - nix-cache-info: Cache-Tag cache-info
 * - nar 200: immutable + Cache-Tag nar,nar:<fileName>
 * - nar 404: negative cache（max-age=60）
 * - nar 206/416: no-store（Workers Cache は 206 を保存しないが意図を明文化）
 * - /api/*: 全応答 no-store（ヒューリスティック 2h キャッシュによる latest stale 事故防止）
 * - メタデータ L0 削除: KV/R2 削除が即座に read path へ反映される（isolate stale なし）
 */
import { describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import { apiApp } from "../../src/api/app";
import { handleNarinfo } from "../../src/handlers/narinfo";
import { handleCacheInfo } from "../../src/handlers/cacheInfo";
import { handleNar } from "../../src/handlers/nar";
import type { Env } from "../../src/types";

function getEnv() {
  return env as unknown as Env;
}

const STORE_HASH = "aaaa0000bbbb1111cccc2222dddd3333";
const NARINFO_BODY = `StorePath: /nix/store/${STORE_HASH}-pkg\nURL: nar/x.nar.zst\n`;
const NAR_FILE = "cafef00d.nar.zst";
const NAR_CONTENT = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

// ─── narinfo ─────────────────────────────────────────────────────────────────

describe("narinfo のキャッシュヘッダ契約", () => {
  test("200: Cache-Control public, max-age=3600", async () => {
    await getEnv().META_KV.put(`narinfo:${STORE_HASH}`, NARINFO_BODY);
    const res = await handleNarinfo(getEnv(), STORE_HASH);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("200: Cache-Tag narinfo,narinfo:<storeHash>", async () => {
    await getEnv().META_KV.put(`narinfo:${STORE_HASH}`, NARINFO_BODY);
    const res = await handleNarinfo(getEnv(), STORE_HASH);
    expect(res.headers.get("cache-tag")).toBe(`narinfo,narinfo:${STORE_HASH}`);
  });

  test("404: negative cache（public, max-age=60）", async () => {
    const res = await handleNarinfo(getEnv(), "0000missing0000missing0000missin");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  test("404: Cache-Tag narinfo-miss,narinfo:<storeHash>（publish 後の purge で negative cache も消せる）", async () => {
    const missing = "0000missing0000missing0000missin";
    const res = await handleNarinfo(getEnv(), missing);
    expect(res.headers.get("cache-tag")).toBe(`narinfo-miss,narinfo:${missing}`);
  });

  test("L0 削除: KV/R2 から消えたら即座に 404 になる（isolate stale なし）", async () => {
    const eenv = getEnv();
    await eenv.META_KV.put(`narinfo:${STORE_HASH}`, NARINFO_BODY);
    const warm = await handleNarinfo(eenv, STORE_HASH);
    expect(warm.status).toBe(200);

    // KV から削除（R2 には元々ない）→ L0 が存在しないため次リクエストで即 404
    await eenv.META_KV.delete(`narinfo:${STORE_HASH}`);
    const stale = await handleNarinfo(eenv, STORE_HASH);
    expect(stale.status).toBe(404);
  });
});

// ─── nix-cache-info ──────────────────────────────────────────────────────────

describe("nix-cache-info のキャッシュヘッダ契約", () => {
  test("Cache-Control public, max-age=3600 + Cache-Tag cache-info", async () => {
    const res = await handleCacheInfo(getEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("cache-tag")).toBe("cache-info");
  });
});

// ─── nar ─────────────────────────────────────────────────────────────────────

describe("nar のキャッシュヘッダ契約", () => {
  async function putNar() {
    await getEnv().NAR_BUCKET.put(`nar/${NAR_FILE}`, NAR_CONTENT);
  }

  test("full 200: immutable + Cache-Tag nar,nar:<fileName>", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${NAR_FILE}`);
    const res = await handleNar(req, getEnv(), NAR_FILE);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("cache-tag")).toBe(`nar,nar:${NAR_FILE}`);
  });

  test("404: negative cache（public, max-age=60）+ Cache-Tag nar-miss,nar:<fileName>", async () => {
    const req = new Request("https://example.com/nar/missing.nar.zst");
    const res = await handleNar(req, getEnv(), "missing.nar.zst");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("cache-tag")).toBe("nar-miss,nar:missing.nar.zst");
  });

  test("206: no-store（Workers Cache は 206 を保存しない仕様の明文化）", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${NAR_FILE}`, {
      headers: { range: "bytes=0-4" },
    });
    const res = await handleNar(req, getEnv(), NAR_FILE);
    expect(res.status).toBe(206);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("416: no-store", async () => {
    await putNar();
    const req = new Request(`https://example.com/nar/${NAR_FILE}`, {
      headers: { range: "bytes=100-199" },
    });
    const res = await handleNar(req, getEnv(), NAR_FILE);
    expect(res.status).toBe(416);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

// ─── /api/* は no-store ──────────────────────────────────────────────────────

describe("/api/* は全応答 no-store（Workers Cache のヒューリスティックキャッシュ防止）", () => {
  test("GET /api/openapi.json → no-store", async () => {
    const res = await apiApp.fetch(
      new Request("https://example.com/api/openapi.json"),
      getEnv(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("GET /api/hosts/:host/latest（404 経路）→ no-store", async () => {
    const res = await apiApp.fetch(
      new Request("https://example.com/api/hosts/no-such-host/latest"),
      getEnv(),
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("認証エラー応答（write 系 401/403）も no-store", async () => {
    const res = await apiApp.fetch(
      new Request("https://example.com/api/gc/dry-run", { method: "POST" }),
      getEnv(),
    );
    expect([401, 403]).toContain(res.status);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
