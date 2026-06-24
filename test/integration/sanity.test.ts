/**
 * test/integration/sanity.test.ts
 *
 * pool-workers 疎通確認テスト。
 * - CONTROL_DB binding が存在すること。
 * - GET /api/openapi.json が 200 を返し、OpenAPI document に write/read route が含まれること。
 *
 * 受入条件: F4（OpenAPI document）/ F7（pool-workers 統合テスト基盤）
 */
import { describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import { apiApp } from "../../src/api/app";
import type { Env } from "../../src/types";

describe("pool-workers 疎通", () => {
  test("CONTROL_DB binding が存在する", () => {
    const typedEnv = env as unknown as Env;
    expect(typedEnv.CONTROL_DB).toBeDefined();
  });

  test("NAR_BUCKET binding が存在する", () => {
    const typedEnv = env as unknown as Env;
    expect(typedEnv.NAR_BUCKET).toBeDefined();
  });

  test("META_KV binding が存在する", () => {
    const typedEnv = env as unknown as Env;
    expect(typedEnv.META_KV).toBeDefined();
  });
});

describe("GET /api/openapi.json", () => {
  test("200 を返す", async () => {
    const req = new Request("https://example.com/api/openapi.json");
    const res = await apiApp.fetch(req, env as unknown as Env);
    expect(res.status).toBe(200);
  });

  test("Content-Type が application/json", async () => {
    const req = new Request("https://example.com/api/openapi.json");
    const res = await apiApp.fetch(req, env as unknown as Env);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  test("OpenAPI document に write route が含まれる（publish/start）", async () => {
    const req = new Request("https://example.com/api/openapi.json");
    const res = await apiApp.fetch(req, env as unknown as Env);
    const doc = await res.json() as Record<string, unknown>;
    const paths = doc["paths"] as Record<string, unknown>;
    expect(paths).toHaveProperty("/api/publish/start");
  });

  test("OpenAPI document に write route が含まれる（ingest）", async () => {
    const req = new Request("https://example.com/api/openapi.json");
    const res = await apiApp.fetch(req, env as unknown as Env);
    const doc = await res.json() as Record<string, unknown>;
    const paths = doc["paths"] as Record<string, unknown>;
    // {buildId}/ingest はパスパラメータなのでいずれかの key にマッチ
    const hasIngest = Object.keys(paths).some((p) => p.includes("ingest"));
    expect(hasIngest).toBe(true);
  });

  test("OpenAPI document に read route が含まれる（latest）", async () => {
    const req = new Request("https://example.com/api/openapi.json");
    const res = await apiApp.fetch(req, env as unknown as Env);
    const doc = await res.json() as Record<string, unknown>;
    const paths = doc["paths"] as Record<string, unknown>;
    const hasLatest = Object.keys(paths).some((p) => p.includes("latest"));
    expect(hasLatest).toBe(true);
  });

  test("write route に bearerAuth security が設定されている", async () => {
    const req = new Request("https://example.com/api/openapi.json");
    const res = await apiApp.fetch(req, env as unknown as Env);
    const doc = await res.json() as Record<string, unknown>;
    const paths = doc["paths"] as Record<string, unknown>;
    const startRoute = paths["/api/publish/start"] as Record<string, unknown> | undefined;
    expect(startRoute).toBeDefined();
    const post = startRoute?.["post"] as Record<string, unknown> | undefined;
    expect(post).toBeDefined();
    const security = post?.["security"] as unknown[] | undefined;
    expect(Array.isArray(security)).toBe(true);
    expect(security?.length).toBeGreaterThan(0);
  });

  test("read route（latest）に security が設定されていない", async () => {
    const req = new Request("https://example.com/api/openapi.json");
    const res = await apiApp.fetch(req, env as unknown as Env);
    const doc = await res.json() as Record<string, unknown>;
    const paths = doc["paths"] as Record<string, unknown>;
    const latestKey = Object.keys(paths).find((p) => p.includes("latest"));
    expect(latestKey).toBeDefined();
    const latestRoute = paths[latestKey!] as Record<string, unknown>;
    const get = latestRoute["get"] as Record<string, unknown> | undefined;
    // security が無いか空配列であることを確認
    const security = get?.["security"];
    const hasNoSecurity = security === undefined || (Array.isArray(security) && security.length === 0);
    expect(hasNoSecurity).toBe(true);
  });
});
