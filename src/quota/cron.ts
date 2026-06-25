import type { Env } from "../types";
import { evaluate } from "./evaluate";
import { fetchR2Usage } from "./analytics";
import { currentMonthUtc } from "./guard";
import { getQuotaSnapshot, setQuotaSnapshot } from "./state";

export async function runQuotaCheck(env: Env, _ctx: ExecutionContext, now: Date): Promise<void> {
  let raw;
  try {
    raw = await fetchR2Usage(env, now);
  } catch (err) {
    console.warn("[quota] analytics fetch failed:", err);
    const prev = await getQuotaSnapshot(env);
    if (prev === null) return;

    const consecutiveFetchFailures = (prev.consecutiveFetchFailures ?? 0) + 1;
    await setQuotaSnapshot(env, { ...prev, consecutiveFetchFailures });
    if (consecutiveFetchFailures >= 3) {
      console.warn("[quota] analytics has failed", consecutiveFetchFailures, "times consecutively");
    }
    return;
  }

  const prev = await getQuotaSnapshot(env);
  const next = evaluate(raw, {
    month: currentMonthUtc(now),
    checkedAt: Math.floor(now.getTime() / 1000),
  });
  next.consecutiveFetchFailures = 0;

  await setQuotaSnapshot(env, next);

  if (prev?.state !== next.state) {
    console.info("[quota] state transition:", prev?.state, "->", next.state);
  }
}
