import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  aggregateUsage,
  metricValue,
  formatTokens,
  formatCost,
  type UsageWindow,
} from "./usage.js";
import type { CheckpointRecord } from "./types.js";

// A fixed "now" so windowing is deterministic. 2025-06-15T00:00:00Z.
const NOW = Date.UTC(2025, 5, 15);
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const rec = (over: Partial<CheckpointRecord> = {}): CheckpointRecord => ({
  runId: "r",
  timestamp: daysAgo(1),
  dimensions: { model: "opus" },
  totalCases: 1,
  casesPassed: 1,
  successRate: 1,
  durationMs: 10,
  totalInputTokens: 100,
  totalOutputTokens: 200,
  costUsd: 0.01,
  ...over,
});

const agg = (records: CheckpointRecord[], window: UsageWindow = "30d", model?: string) =>
  aggregateUsage(records, { window, metric: "tokens", now: NOW, model });

describe("aggregateUsage windowing", () => {
  it("excludes records older than the 30d window", () => {
    const s = agg([rec({ timestamp: daysAgo(2) }), rec({ timestamp: daysAgo(45) })]);
    expect(s.filteredCount).toBe(1);
    expect(s.totals.runs).toBe(1);
  });

  it("7d is tighter than 30d", () => {
    const records = [rec({ timestamp: daysAgo(3) }), rec({ timestamp: daysAgo(20) })];
    expect(agg(records, "7d").filteredCount).toBe(1);
    expect(agg(records, "30d").filteredCount).toBe(2);
  });

  it("all keeps everything regardless of age", () => {
    const s = agg([rec({ timestamp: daysAgo(2) }), rec({ timestamp: daysAgo(400) })], "all");
    expect(s.filteredCount).toBe(2);
  });

  it("drops records with an unparseable timestamp", () => {
    const s = agg([rec(), rec({ timestamp: "not-a-date" })]);
    expect(s.filteredCount).toBe(1);
  });
});

describe("aggregateUsage per-model rollup", () => {
  it("sums tokens/cost/runs per model", () => {
    const s = agg([
      rec({ dimensions: { model: "opus" }, totalInputTokens: 100, totalOutputTokens: 200, costUsd: 0.01 }),
      rec({ dimensions: { model: "opus" }, totalInputTokens: 50, totalOutputTokens: 50, costUsd: 0.02 }),
      rec({ dimensions: { model: "sonnet" }, totalInputTokens: 10, totalOutputTokens: 10, costUsd: 0.005 }),
    ]);
    const opus = s.rows.find((r) => r.model === "opus")!;
    expect(opus).toMatchObject({ inTokens: 150, outTokens: 250, runs: 2 });
    expect(opus.cost).toBeCloseTo(0.03);
    expect(s.totals.runs).toBe(3);
  });

  it("resolves model via dimensions.model → model → 'unknown'", () => {
    const s = agg([
      rec({ dimensions: {}, model: "haiku" }),
      rec({ dimensions: {}, model: undefined }),
    ]);
    expect(s.rows.map((r) => r.model).sort()).toEqual(["haiku", "unknown"]);
  });

  it("filters to one model (case-insensitive)", () => {
    const s = agg(
      [rec({ dimensions: { model: "Opus" } }), rec({ dimensions: { model: "sonnet" } })],
      "30d",
      "opus",
    );
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].model).toBe("Opus");
  });
});

describe("aggregateUsage metric + sorting", () => {
  it("sorts rows by the chosen metric, and switching metric can reorder", () => {
    const records = [
      // many tokens, little cost
      rec({ dimensions: { model: "cheap-big" }, totalInputTokens: 9000, totalOutputTokens: 0, costUsd: 0.01 }),
      // few tokens, lots of cost
      rec({ dimensions: { model: "pricey-small" }, totalInputTokens: 100, totalOutputTokens: 0, costUsd: 5 }),
    ];
    const byTokens = aggregateUsage(records, { window: "30d", metric: "tokens", now: NOW });
    const byCost = aggregateUsage(records, { window: "30d", metric: "cost", now: NOW });
    expect(byTokens.rows[0].model).toBe("cheap-big");
    expect(byCost.rows[0].model).toBe("pricey-small");
  });

  it("metricValue picks tokens vs cost", () => {
    const v = { inTokens: 3, outTokens: 4, cost: 9 };
    expect(metricValue(v, "tokens")).toBe(7);
    expect(metricValue(v, "cost")).toBe(9);
  });
});

describe("aggregateUsage cost safety", () => {
  it("treats null/absent cost as 0 and never NaN", () => {
    const s = agg([rec({ costUsd: null }), rec({ costUsd: undefined })]);
    expect(s.totals.cost).toBe(0);
    expect(Number.isNaN(s.totals.cost)).toBe(false);
    expect(s.hasCost).toBe(false);
  });

  it("hasCost is true when any record carries a cost", () => {
    expect(agg([rec({ costUsd: null }), rec({ costUsd: 0.02 })]).hasCost).toBe(true);
  });

  it("treats missing token fields as 0", () => {
    const s = agg([rec({ totalInputTokens: undefined, totalOutputTokens: undefined })]);
    expect(s.totals.inTokens).toBe(0);
    expect(s.totals.outTokens).toBe(0);
  });
});

describe("aggregateUsage day buckets", () => {
  it("merges same-day records and returns active days chronologically", () => {
    const s = agg([
      rec({ timestamp: daysAgo(1) }),
      rec({ timestamp: daysAgo(1) }),
      rec({ timestamp: daysAgo(5) }),
    ]);
    expect(s.days).toHaveLength(2);
    expect(s.days[0].day < s.days[1].day).toBe(true);
    // The two day-1 records merge into one bucket of 2x tokens.
    const newest = s.days[s.days.length - 1];
    expect(newest.inTokens).toBe(200);
  });

  it("carries a per-model split on each day (feeds the stacked chart)", () => {
    const s = agg([
      rec({ timestamp: daysAgo(1), dimensions: { model: "opus" }, totalInputTokens: 100, totalOutputTokens: 0 }),
      rec({ timestamp: daysAgo(1), dimensions: { model: "sonnet" }, totalInputTokens: 30, totalOutputTokens: 0 }),
    ]);
    const day = s.days[s.days.length - 1];
    expect(Object.keys(day.models).sort()).toEqual(["opus", "sonnet"]);
    expect(day.models.opus.inTokens).toBe(100);
    expect(day.models.sonnet.inTokens).toBe(30);
  });
});

describe("aggregateUsage over a real (anonymized) checkpoint log", () => {
  const records: CheckpointRecord[] = readFileSync(
    new URL("./__fixtures__/checkpoints.sample.jsonl", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CheckpointRecord);

  // The fixture is single-day (2026-05-30), so window with a `now` on that day.
  const FIXTURE_NOW = Date.parse("2026-05-30T23:59:59Z");

  it("rolls up the 17-record sample to its known totals", () => {
    const s = aggregateUsage(records, { window: "all", metric: "tokens", now: FIXTURE_NOW });
    expect(s.totals.runs).toBe(17);
    expect(s.totals.inTokens).toBe(312_622);
    expect(s.totals.outTokens).toBe(12_007);
    expect(s.totals.cost).toBeCloseTo(0.336988, 5);
  });

  it("surfaces the null-model record as the 'unknown' model", () => {
    const s = aggregateUsage(records, { window: "all", metric: "tokens", now: FIXTURE_NOW });
    const models = Object.fromEntries(s.rows.map((r) => [r.model, r.runs]));
    expect(models["openai/gpt-5.4"]).toBe(16);
    expect(models["unknown"]).toBe(1);
  });
});

describe("formatting helpers", () => {
  it("formatTokens uses k/m suffixes", () => {
    expect(formatTokens(880)).toBe("880");
    expect(formatTokens(21_900)).toBe("21.9k");
    expect(formatTokens(1_200_000)).toBe("1.2m");
  });

  it("formatCost trims trailing zeros and shows $0 for nothing", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(1.23)).toBe("$1.23");
    expect(formatCost(1.5)).toBe("$1.5");
  });
});
