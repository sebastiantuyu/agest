import { describe, it, expect } from "vitest";
import { sweepKey, groupSweeps, mergeAreas, renderAreaRadar } from "./coverage";
import type { AreaCoverage, CheckpointRecord } from "./types";

function rec(partial: Partial<CheckpointRecord>): CheckpointRecord {
  return {
    runId: partial.runId ?? "r-1",
    timestamp: partial.timestamp ?? "2026-01-01T00:00:00.000Z",
    dimensions: {},
    totalCases: partial.totalCases ?? 1,
    casesPassed: 1,
    successRate: 1,
    durationMs: 1,
    ...partial,
  } as CheckpointRecord;
}

function area(partial: Partial<AreaCoverage>): AreaCoverage {
  return {
    id: partial.id ?? "refusal",
    scenes: partial.scenes ?? 1,
    passed: partial.passed ?? 1,
    passRate: partial.passRate ?? 1,
    trials: partial.trials ?? 1,
    trialPasses: partial.trialPasses ?? 1,
    inCatalog: partial.inCatalog ?? true,
    minScenes: partial.minScenes,
  };
}

describe("sweepKey", () => {
  it("uses sweepId when present", () => {
    expect(sweepKey(rec({ sweepId: "sweep-1", runId: "sweep-1-abcd" }))).toBe("sweep-1");
  });
  it("falls back to runId for standalone runs (no sweepId)", () => {
    expect(sweepKey(rec({ runId: "local-abcd" }))).toBe("local-abcd");
  });
});

describe("groupSweeps", () => {
  it("groups every agent() record sharing a sweepId into one run", () => {
    const records = [
      rec({ sweepId: "s1", runId: "s1-a" }),
      rec({ sweepId: "s1", runId: "s1-b" }),
      rec({ sweepId: "s2", runId: "s2-a" }),
    ];
    const sweeps = groupSweeps(records);
    expect(sweeps).toHaveLength(2);
    expect(sweeps.find((s) => s.key === "s1")!.records).toHaveLength(2);
  });

  it("sorts sweeps newest first by latest timestamp", () => {
    const sweeps = groupSweeps([
      rec({ sweepId: "old", timestamp: "2026-01-01T00:00:00.000Z" }),
      rec({ sweepId: "new", timestamp: "2026-02-01T00:00:00.000Z" }),
    ]);
    expect(sweeps.map((s) => s.key)).toEqual(["new", "old"]);
  });

  it("takes the latest timestamp within a group as the group's timestamp", () => {
    const sweeps = groupSweeps([
      rec({ sweepId: "s", runId: "s-a", timestamp: "2026-01-01T00:00:00.000Z" }),
      rec({ sweepId: "s", runId: "s-b", timestamp: "2026-01-02T00:00:00.000Z" }),
    ]);
    expect(sweeps[0].timestamp).toBe("2026-01-02T00:00:00.000Z");
  });
});

describe("mergeAreas", () => {
  it("sums scenes/passed/trials by id and recomputes pass rate", () => {
    const merged = mergeAreas([
      area({ id: "refusal", scenes: 2, passed: 1, trials: 2, trialPasses: 1 }),
      area({ id: "refusal", scenes: 2, passed: 2, trials: 4, trialPasses: 3 }),
      area({ id: "tool-use", scenes: 1, passed: 0, trials: 1, trialPasses: 0 }),
    ]);
    const refusal = merged.get("refusal")!;
    expect(refusal.scenes).toBe(4);
    expect(refusal.passed).toBe(3);
    expect(refusal.trials).toBe(6);
    expect(refusal.trialPasses).toBe(4);
    expect(refusal.passRate).toBe(0.75);
    expect(merged.get("tool-use")!.passRate).toBe(0);
  });
});

describe("renderAreaRadar — present vs absent categories", () => {
  // 0% (scenes>0, passed=0) is a real, tested outcome; an absent category
  // (no entry, or scenes=0) is "never exercised" and must be omitted entirely.
  const expected = new Map<string, number | undefined>([
    ["correctness", 8],
    ["refusal", 5],
    ["format", 4],
    ["memory", 4],
  ]);

  it("KEEPS a tested-but-0% area (axis drawn, labeled 0%)", () => {
    const rollup = new Map<string, AreaCoverage>([
      ["correctness", area({ id: "correctness", scenes: 5, passed: 0, passRate: 0, trials: 5, trialPasses: 0 })],
      ["refusal", area({ id: "refusal", scenes: 4, passed: 3, passRate: 0.75 })],
      ["format", area({ id: "format", scenes: 4, passed: 4, passRate: 1 })],
    ]);
    const out = renderAreaRadar(rollup, expected);
    expect(out).toContain("CORRECTNESS"); // 0% is still plotted
    expect(out).toContain("0%");
  });

  it("OMITS an absent category (no rollup entry)", () => {
    const rollup = new Map<string, AreaCoverage>([
      ["correctness", area({ id: "correctness", scenes: 5, passed: 3, passRate: 0.6 })],
      ["refusal", area({ id: "refusal", scenes: 4, passed: 3, passRate: 0.75 })],
      ["format", area({ id: "format", scenes: 4, passed: 4, passRate: 1 })],
    ]);
    const out = renderAreaRadar(rollup, expected); // memory is opted-in but never exercised
    expect(out).not.toContain("MEMORY");
  });

  it("OMITS a present-but-zero-scene category (distinct from 0% pass)", () => {
    const rollup = new Map<string, AreaCoverage>([
      ["correctness", area({ id: "correctness", scenes: 5, passed: 3, passRate: 0.6 })],
      ["refusal", area({ id: "refusal", scenes: 4, passed: 3, passRate: 0.75 })],
      ["format", area({ id: "format", scenes: 4, passed: 4, passRate: 1 })],
      ["memory", area({ id: "memory", scenes: 0, passed: 0, passRate: 0, trials: 0, trialPasses: 0 })],
    ]);
    expect(renderAreaRadar(rollup, expected)).not.toContain("MEMORY");
  });

  it("returns empty when fewer than 3 areas have data", () => {
    const rollup = new Map<string, AreaCoverage>([
      ["refusal", area({ id: "refusal", scenes: 4, passed: 3, passRate: 0.75 })],
      ["format", area({ id: "format", scenes: 4, passed: 4, passRate: 1 })],
    ]);
    expect(renderAreaRadar(rollup, expected)).toBe("");
  });
});
