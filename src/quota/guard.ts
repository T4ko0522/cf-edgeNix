import type { Env } from "../types";
import { getQuotaSnapshot } from "./state";

export async function checkReadPathAllowed(env: Env): Promise<
  | { ok: true }
  | { ok: false; response: Response }
> {
  const snapshot = await getQuotaSnapshot(env);
  if (snapshot === null || snapshot.state !== "killed") return { ok: true };
  if (snapshot.month !== currentMonthUtc(new Date())) return { ok: true };

  return {
    ok: false,
    response: new Response("cache temporarily unavailable: monthly free-tier quota reached\n", {
      status: 503,
      headers: {
        "Retry-After": String(secondsUntilMonthEnd(new Date())),
        "Cache-Control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "x-edgenix-quota-state": "killed",
      },
    }),
  };
}

export function secondsUntilMonthEnd(now: Date): number {
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(0, Math.ceil((monthEnd - now.getTime()) / 1000));
}

export function currentMonthUtc(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
