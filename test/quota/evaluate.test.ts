import { describe, expect, test } from "vitest";
import { R2_FREE_TIER } from "../../src/quota/limits";
import { evaluate } from "../../src/quota/evaluate";

const opts = { month: "2026-06", checkedAt: 1_719_273_600 };

describe("evaluate", () => {
  test.each([
    ["79.9%", 0.799, "ok"],
    ["80%", 0.8, "warn"],
    ["94.9%", 0.949, "warn"],
    ["95%", 0.95, "killed"],
    ["100%", 1, "killed"],
  ] as const)("storageBytes %s → %s", (_label, ratio, state) => {
    const snapshot = evaluate({
      storageBytes: R2_FREE_TIER.storageBytes * ratio,
      classAOperations: 0,
      classBOperations: 0,
    }, opts);

    expect(snapshot.state).toBe(state);
    expect(snapshot.metrics.storageBytes.ratio).toBeCloseTo(ratio);
  });

  test("Class A と Class B が異なる重みの場合は最大状態を採用", () => {
    const snapshot = evaluate({
      storageBytes: 0,
      classAOperations: R2_FREE_TIER.classAOperations * 0.8,
      classBOperations: R2_FREE_TIER.classBOperations * 0.95,
    }, opts);

    expect(snapshot.state).toBe("killed");
    expect(snapshot.reason).toBe("classBOperations exceeded 95% (9500000/10000000)");
  });

  test("全部 0 → ok", () => {
    const snapshot = evaluate({
      storageBytes: 0,
      classAOperations: 0,
      classBOperations: 0,
    }, opts);

    expect(snapshot.state).toBe("ok");
    expect(snapshot.reason).toBeUndefined();
  });
});
