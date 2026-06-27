import { afterEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../../src/types";
import { classifyActionType, fetchR2Usage } from "../../src/quota/analytics";

function makeEnv(): Env {
  return {
    NAR_BUCKET: {} as R2Bucket,
    META_KV: {} as KVNamespace,
    CONTROL_DB: {} as D1Database,
    CF_ACCOUNT_ID: "account-id",
    CF_ANALYTICS_TOKEN: "token",
    QUOTA_R2_BUCKET_NAME: "bucket",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classifyActionType", () => {
  test.each([
    "ListBuckets",
    "PutBucket",
    "ListObjects",
    "PutObject",
    "CopyObject",
    "CompleteMultipartUpload",
    "CreateMultipartUpload",
    "ListMultipartUploads",
    "UploadPart",
    "UploadPartCopy",
    "ListParts",
    "PutBucketEncryption",
    "PutBucketCors",
    "PutBucketLifecycleConfiguration",
  ])("%s は Class A", (actionType) => {
    expect(classifyActionType(actionType)).toBe("A");
  });

  test.each([
    "HeadBucket",
    "HeadObject",
    "GetObject",
    "UsageSummary",
    "GetBucketEncryption",
    "GetBucketLocation",
    "GetBucketCors",
    "GetBucketLifecycleConfiguration",
  ])("%s は Class B", (actionType) => {
    expect(classifyActionType(actionType)).toBe("B");
  });

  test.each([
    "DeleteObject",
    "DeleteBucket",
    "AbortMultipartUpload",
  ])("%s は free", (actionType) => {
    expect(classifyActionType(actionType)).toBe("free");
  });

  test("判定不能な actionType は warn して Class A 扱い", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(classifyActionType("Other")).toBe("A");
    expect(warn).toHaveBeenCalledWith("[quota] unknown actionType:", "Other");
  });
});

describe("fetchR2Usage", () => {
  test("GraphQL response から storage と Class A/B 操作数を集計", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: {
        viewer: {
          accounts: [{
            r2StorageAdaptiveGroups: [
              { max: { payloadSize: 1234 } },
            ],
            r2OperationsAdaptiveGroups: [
              { dimensions: { actionType: "PutObject" }, sum: { requests: 10 } },
              { dimensions: { actionType: "GetObject" }, sum: { requests: 20 } },
              { dimensions: { actionType: "HeadObject" }, sum: { requests: 30 } },
              { dimensions: { actionType: "DeleteObject" }, sum: { requests: 40 } },
              { dimensions: { actionType: "Other" }, sum: { requests: 50 } },
            ],
          }],
        },
      },
    })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(fetchR2Usage(makeEnv(), new Date("2026-06-25T12:00:00.000Z"))).resolves.toEqual({
      storageBytes: 1234,
      classAOperations: 60,
      classBOperations: 50,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/graphql",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
      }),
    );
    expect(warn).toHaveBeenCalledWith("[quota] unknown actionType:", "Other");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      query: string;
      variables: Record<string, string>;
    };
    expect(body.query).toContain("$accountTag: String!");
    expect(body.query).toContain("$bucketName: String!");
    expect(body.query).toContain("$storageSince: Time!");
    expect(body.query).toContain("$opsSince: Time!");
    expect(body.query).toContain("$opsUntil: Time!");
    expect(body.query).toContain("orderBy: [datetime_DESC]");
    expect(body.variables.storageSince).toBe("2026-06-25T11:00:00.000Z");
    expect(body.variables.opsSince).toBe("2026-06-01T00:00:00.000Z");
    expect(body.variables.opsUntil).toBe("2026-06-25T12:00:00.000Z");
  });

  test("storage は直近スナップショットのみを採用 (月内ピークは無視)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: {
        viewer: {
          accounts: [{
            r2StorageAdaptiveGroups: [
              { dimensions: { datetime: "2026-06-25T11:55:00Z" }, max: { payloadSize: 1_500_000_000 } },
            ],
            r2OperationsAdaptiveGroups: [],
          }],
        },
      },
    })));

    await expect(fetchR2Usage(makeEnv(), new Date("2026-06-25T12:00:00.000Z"))).resolves.toEqual({
      storageBytes: 1_500_000_000,
      classAOperations: 0,
      classBOperations: 0,
    });
  });

  test("storage 結果が空でも 0 を返す (throw しない)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: {
        viewer: {
          accounts: [{
            r2StorageAdaptiveGroups: [],
            r2OperationsAdaptiveGroups: [],
          }],
        },
      },
    })));

    await expect(fetchR2Usage(makeEnv(), new Date("2026-06-25T12:00:00.000Z"))).resolves.toEqual({
      storageBytes: 0,
      classAOperations: 0,
      classBOperations: 0,
    });
  });

  test("response.ok === false は throw", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ng", { status: 500 }));

    await expect(fetchR2Usage(makeEnv(), new Date("2026-06-25T12:00:00.000Z")))
      .rejects.toThrow("Cloudflare GraphQL API failed: 500");
  });

  test("errors フィールドは throw", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      errors: [{ message: "bad query" }],
    })));

    await expect(fetchR2Usage(makeEnv(), new Date("2026-06-25T12:00:00.000Z")))
      .rejects.toThrow("Cloudflare GraphQL API returned errors");
  });
});
