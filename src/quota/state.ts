import type { Env } from "../types";
import { QuotaSnapshotSchema } from "../schemas/quota";
import { QUOTA_STATE_KV_KEY, QUOTA_EPOCH_KV_KEY } from "../storage/keys";
import { R2_FREE_TIER } from "./limits";
import type { QuotaSnapshot } from "./types";

let l0: { snapshot: QuotaSnapshot | null; epoch: number } | null = null;

async function readEpoch(env: Env): Promise<number> {
  const raw = await env.META_KV.get(QUOTA_EPOCH_KV_KEY, "text");
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export async function getQuotaSnapshot(env: Env): Promise<QuotaSnapshot | null> {
  const remoteEpoch = await readEpoch(env);
  if (l0 && l0.epoch === remoteEpoch) return l0.snapshot;

  const raw = await env.META_KV.get(QUOTA_STATE_KV_KEY, "text");
  if (raw === null) {
    l0 = { snapshot: null, epoch: remoteEpoch };
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
  l0 = { snapshot, epoch: remoteEpoch };
  return snapshot;
}

export async function setQuotaSnapshot(env: Env, snapshot: QuotaSnapshot): Promise<void> {
  const nextEpoch = (await readEpoch(env)) + 1;
  await Promise.all([
    env.META_KV.put(QUOTA_STATE_KV_KEY, JSON.stringify(snapshot)),
    env.META_KV.put(QUOTA_EPOCH_KV_KEY, String(nextEpoch)),
  ]);
  l0 = { snapshot, epoch: nextEpoch };
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
