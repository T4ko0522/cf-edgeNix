import type { Env } from "../types";

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

// storage は「現時点の積載量」で判定したいので直近 N 時間の最新スナップショットを取る。
// 月内ピーク (publish 直後など) を引きずると GC 後に積載が減っても kill が解除されない。
const STORAGE_LOOKBACK_HOURS = 1;

const CLASS_A_ACTIONS = new Set([
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
  "PutBucketNotificationConfiguration",
  "PutBucketSippyConfiguration",
  "PutBucketStorageClass",
]);

const CLASS_B_ACTIONS = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
  "GetBucketNotificationConfiguration",
  "GetBucketSippyConfiguration",
  "GetBucketStorageClass",
]);

const FREE_ACTIONS = new Set([
  "DeleteObject",
  "DeleteBucket",
  "AbortMultipartUpload",
  "DeleteBucketEncryption",
  "DeleteBucketCors",
  "DeleteBucketLifecycleConfiguration",
  "DeleteBucketSippyConfiguration",
]);

type Usage = {
  storageBytes: number;
  classAOperations: number;
  classBOperations: number;
};

type GraphQLResponse = {
  data?: {
    viewer?: {
      accounts?: Array<{
        r2StorageAdaptiveGroups?: StorageGroup[];
        r2OperationsAdaptiveGroups?: OperationGroup[];
      }>;
    };
  };
  errors?: Array<{ message?: string }>;
};

type StorageGroup = {
  dimensions?: {
    datetime?: string;
  };
  max?: {
    payloadSize?: number;
  };
};

type OperationGroup = {
  dimensions?: {
    actionType?: string;
  };
  sum?: {
    requests?: number;
  };
};

export function classifyActionType(actionType: string): "A" | "B" | "free" {
  if (CLASS_A_ACTIONS.has(actionType)) return "A";
  if (CLASS_B_ACTIONS.has(actionType)) return "B";
  if (FREE_ACTIONS.has(actionType)) return "free";
  console.warn("[quota] unknown actionType:", actionType);
  return "A";
}

export async function fetchR2Usage(env: Env, now: Date): Promise<Usage> {
  if (!env.CF_ACCOUNT_ID) throw new Error("CF_ACCOUNT_ID is required");
  if (!env.CF_ANALYTICS_TOKEN) throw new Error("CF_ANALYTICS_TOKEN is required");
  if (!env.QUOTA_R2_BUCKET_NAME) throw new Error("QUOTA_R2_BUCKET_NAME is required");

  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: R2_USAGE_QUERY,
      variables: {
        accountTag: env.CF_ACCOUNT_ID,
        bucketName: env.QUOTA_R2_BUCKET_NAME,
        storageSince: storageLookbackStart(now).toISOString(),
        opsSince: monthStartUtc(now).toISOString(),
        opsUntil: now.toISOString(),
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cloudflare GraphQL API failed: ${response.status} ${body}`);
  }

  const payload = await response.json() as GraphQLResponse;
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(
      `Cloudflare GraphQL API returned errors: ${payload.errors.map((e) => e.message ?? "(no message)").join("; ")}`,
    );
  }

  const account = payload.data?.viewer?.accounts?.[0];
  if (!account) {
    return { storageBytes: 0, classAOperations: 0, classBOperations: 0 };
  }

  // R2 課金は GB-month 月平均だが、kill-switch 目的では「現在 R2 に載っている量」で
  // 10GB 超過を防ぐ近似 guard として割り切る。直近 STORAGE_LOOKBACK_HOURS 内の
  // 最新スナップショット 1 件の payloadSize を採用 (月内ピークは引きずらない)。
  const storageBytes = account.r2StorageAdaptiveGroups?.[0]?.max?.payloadSize ?? 0;
  let classAOperations = 0;
  let classBOperations = 0;

  for (const group of account.r2OperationsAdaptiveGroups ?? []) {
    const actionType = group.dimensions?.actionType;
    if (!actionType) continue;

    const requests = group.sum?.requests ?? 0;
    const actionClass = classifyActionType(actionType);
    if (actionClass === "A") classAOperations += requests;
    if (actionClass === "B") classBOperations += requests;
  }

  return { storageBytes, classAOperations, classBOperations };
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function storageLookbackStart(now: Date): Date {
  return new Date(now.getTime() - STORAGE_LOOKBACK_HOURS * 60 * 60 * 1000);
}

const R2_USAGE_QUERY = `
query R2Usage(
  $accountTag: String!
  $bucketName: String!
  $storageSince: Time!
  $opsSince: Time!
  $opsUntil: Time!
) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2StorageAdaptiveGroups(
        limit: 1
        filter: { bucketName: $bucketName, datetime_geq: $storageSince }
        orderBy: [datetime_DESC]
      ) {
        dimensions {
          datetime
        }
        max {
          payloadSize
        }
      }
      r2OperationsAdaptiveGroups(
        limit: 1000
        filter: { bucketName: $bucketName, datetime_geq: $opsSince, datetime_leq: $opsUntil }
      ) {
        dimensions {
          actionType
        }
        sum {
          requests
        }
      }
    }
  }
}
`;
