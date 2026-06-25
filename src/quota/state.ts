import type { Env } from "../types";
import { QuotaSnapshotSchema } from "../schemas/quota";
import { QUOTA_STATE_KV_KEY } from "../storage/keys";
import { R2_FREE_TIER } from "./limits";
import type { QuotaSnapshot } from "./types";

const L0_TTL_MS = 30_000;

let l0: { snapshot: QuotaSnapshot | null; expiresAt: number } | null = null;

export async function getQuotaSnapshot(env: Env): Promise<QuotaSnapshot | null> {
  const now = Date.now();
  if (l0 && l0.expiresAt > now) return l0.snapshot;

  const raw = await env.META_KV.get(QUOTA_STATE_KV_KEY, "text");
  if (raw === null) {
    l0 = { snapshot: null, expiresAt: now + L0_TTL_MS };
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn("[quota] snapshot JSON parse failed:", err);
    return null;
  }

  const result = QuotaSnapshotSchema.safeParse(parsed);
  if (!result.success) {
    console.warn("[quota] snapshot schema validation failed:", result.error);
    return null;
  }

  const snapshot = result.data;
  l0 = { snapshot, expiresAt: now + L0_TTL_MS };
  return snapshot;
}

export async function setQuotaSnapshot(env: Env, snapshot: QuotaSnapshot): Promise<void> {
  await env.META_KV.put(QUOTA_STATE_KV_KEY, JSON.stringify(snapshot));
  l0 = { snapshot, expiresAt: Date.now() + L0_TTL_MS };
}

export async function clearQuotaSnapshot(env: Env): Promise<void> {
  await setQuotaSnapshot(env, okSnapshot(new Date()));
}

export function __resetForTest(): void {
  l0 = null;
}

function okSnapshot(now: Date): QuotaSnapshot {
  return {
    state: "ok",
    month: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`,
    checkedAt: Math.floor(now.getTime() / 1000),
    metrics: {
      storageBytes: { value: 0, limit: R2_FREE_TIER.storageBytes, ratio: 0 },
      classAOperations: { value: 0, limit: R2_FREE_TIER.classAOperations, ratio: 0 },
      classBOperations: { value: 0, limit: R2_FREE_TIER.classBOperations, ratio: 0 },
    },
  };
}
