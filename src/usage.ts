import { parseArgs } from "node:util";
import { readCheckpoints } from "./reports.js";
import { c } from "./logger.js";
import type { CheckpointRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UsageWindow = "7d" | "30d" | "all";
export type UsageMetric = "tokens" | "cost";

export interface UsageModelRow {
  model: string;
  inTokens: number;
  outTokens: number;
  cost: number;
  runs: number;
}

export interface UsageDayBucket {
  day: string; // YYYY-MM-DD
  inTokens: number;
  outTokens: number;
  cost: number;
}

export interface UsageSummary {
  /** Per-model rows, sorted by the chosen metric descending. */
  rows: UsageModelRow[];
  /** Active days only (≥1 run), chronological. */
  days: UsageDayBucket[];
  totals: { inTokens: number; outTokens: number; cost: number; runs: number };
  window: UsageWindow;
  metric: UsageMetric;
  /** Records kept after window + model filtering. */
  filteredCount: number;
  /** True if any kept record carried a cost figure. */
  hasCost: boolean;
}

const DAY_MS = 86_400_000;
const WINDOW_DAYS: Record<Exclude<UsageWindow, "all">, number> = {
  "7d": 7,
  "30d": 30,
};

/** Resolve a record's model the same way checkpointToReport does. */
function recModel(rec: CheckpointRecord): string {
  return rec.dimensions?.model ?? rec.model ?? "unknown";
}

/** The value a row/day contributes to the chosen metric (for sorting + bars). */
export function metricValue(
  v: { inTokens: number; outTokens: number; cost: number },
  metric: UsageMetric,
): number {
  return metric === "cost" ? v.cost : v.inTokens + v.outTokens;
}

// ---------------------------------------------------------------------------
// Aggregation (pure — unit tested)
// ---------------------------------------------------------------------------

/**
 * Fold checkpoint records into a usage summary: per-model rows + per-day
 * buckets, restricted to a time window. `now` is injected so windowing is
 * deterministic in tests. Cost is treated as 0 when a record lacks it, so the
 * sums never go NaN — `hasCost` records whether any real cost was seen.
 */
export function aggregateUsage(
  records: CheckpointRecord[],
  opts: { window: UsageWindow; metric: UsageMetric; now: number; model?: string },
): UsageSummary {
  const { window, metric, now, model } = opts;
  const cutoff = window === "all" ? -Infinity : now - WINDOW_DAYS[window] * DAY_MS;
  const modelFilter = model?.toLowerCase();

  const byModel = new Map<string, UsageModelRow>();
  const byDay = new Map<string, UsageDayBucket>();
  const totals = { inTokens: 0, outTokens: 0, cost: 0, runs: 0 };
  let filteredCount = 0;
  let hasCost = false;

  for (const rec of records) {
    const ts = new Date(rec.timestamp).getTime();
    if (Number.isNaN(ts) || ts < cutoff) continue;

    const m = recModel(rec);
    if (modelFilter && m.toLowerCase() !== modelFilter) continue;

    const inTok = rec.totalInputTokens ?? 0;
    const outTok = rec.totalOutputTokens ?? 0;
    const cost = rec.costUsd ?? 0;
    if (rec.costUsd != null) hasCost = true;

    filteredCount++;
    totals.inTokens += inTok;
    totals.outTokens += outTok;
    totals.cost += cost;
    totals.runs += 1;

    const row = byModel.get(m) ?? { model: m, inTokens: 0, outTokens: 0, cost: 0, runs: 0 };
    row.inTokens += inTok;
    row.outTokens += outTok;
    row.cost += cost;
    row.runs += 1;
    byModel.set(m, row);

    const dayKey = rec.timestamp.slice(0, 10);
    const day = byDay.get(dayKey) ?? { day: dayKey, inTokens: 0, outTokens: 0, cost: 0 };
    day.inTokens += inTok;
    day.outTokens += outTok;
    day.cost += cost;
    byDay.set(dayKey, day);
  }

  const rows = [...byModel.values()].sort(
    (a, b) => metricValue(b, metric) - metricValue(a, metric),
  );
  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));

  return { rows, days, totals, window, metric, filteredCount, hasCost };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Compact token count: 880 / 21.9k / 1.2m (lowercase, 1 decimal). */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

/** `$1.2345` with trailing zeros trimmed; `$0` for nothing. */
export function formatCost(n: number): string {
  if (n === 0) return "$0";
  return `$${Number(n.toFixed(4))}`;
}

function formatMetric(
  v: { inTokens: number; outTokens: number; cost: number },
  metric: UsageMetric,
): string {
  return metric === "cost"
    ? formatCost(v.cost)
    : formatTokens(v.inTokens + v.outTokens);
}

const W = 62;

function bar(value: number, max: number, width = 24): string {
  if (max <= 0) return "░".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function windowLabel(window: UsageWindow): string {
  return window === "all" ? "all time" : `last ${WINDOW_DAYS[window]} days`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(s: UsageSummary): void {
  const metricTitle = s.metric === "cost" ? "Cost" : "Tokens";

  console.log("\n" + "━".repeat(W));
  console.log(
    `  ${c.bold("AGEST USAGE")}  ${c.dim("·")}  ${s.totals.runs} run${s.totals.runs !== 1 ? "s" : ""}` +
      `  ${c.dim("·")}  ${c.dim(windowLabel(s.window))}  ${c.dim("·")}  ${c.dim(`metric: ${s.metric}`)}`,
  );
  console.log("━".repeat(W));

  // Per-day chart
  console.log(`\n  ${metricTitle} per Day`);
  console.log("  " + "─".repeat(W - 2));
  const maxDay = Math.max(0, ...s.days.map((d) => metricValue(d, s.metric)));
  for (const d of s.days) {
    const b = bar(metricValue(d, s.metric), maxDay);
    const val = formatMetric(d, s.metric).padStart(8);
    console.log(`  ${c.dim(d.day)}  ${b}  ${val}`);
  }

  // Per-model breakdown
  console.log(`\n  By Model`);
  console.log("  " + "─".repeat(W - 2));
  const grand = s.rows.reduce((sum, r) => sum + metricValue(r, s.metric), 0);
  for (const r of s.rows) {
    const pct = grand > 0 ? (metricValue(r, s.metric) / grand) * 100 : 0;
    const head = `${c.bold(r.model)} ${c.dim(`(${pct.toFixed(1)}%)`)}`;
    const detail =
      `In: ${formatTokens(r.inTokens)} ${c.dim("·")} Out: ${formatTokens(r.outTokens)}` +
      (s.hasCost ? ` ${c.dim("·")} ${formatCost(r.cost)}` : "") +
      ` ${c.dim(`· ${r.runs} run${r.runs !== 1 ? "s" : ""}`)}`;
    console.log(`  ${head}`);
    console.log(`    ${c.dim(detail)}`);
  }

  // Totals
  console.log("\n" + "━".repeat(W));
  const totalCost = s.hasCost ? `  ${c.dim("·")}  Cost: ${c.green(formatCost(s.totals.cost))}` : "";
  console.log(
    `  Total  ${c.dim("·")}  In: ${formatTokens(s.totals.inTokens)}` +
      `  ${c.dim("·")}  Out: ${formatTokens(s.totals.outTokens)}${totalCost}`,
  );
  console.log("━".repeat(W) + "\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const WINDOWS = new Set<UsageWindow>(["7d", "30d", "all"]);
const METRICS = new Set<UsageMetric>(["tokens", "cost"]);

async function main(args: string[]): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        window: { type: "string", default: "30d" },
        metric: { type: "string", default: "tokens" },
        model: { type: "string" },
      },
      allowPositionals: true,
    }));
  } catch (err) {
    console.error(`  Error: ${(err as Error).message}`);
    process.exit(1);
  }

  const window = values.window as UsageWindow;
  const metric = values.metric as UsageMetric;
  if (!WINDOWS.has(window)) {
    console.error(`  Error: --window must be one of 7d, 30d, all (got "${window}")`);
    process.exit(1);
  }
  if (!METRICS.has(metric)) {
    console.error(`  Error: --metric must be one of tokens, cost (got "${metric}")`);
    process.exit(1);
  }

  const cwd = process.cwd();
  const records = await readCheckpoints(cwd);
  if (records.length === 0) {
    console.log("\n  No usage data. Run some agent tests first.\n");
    return;
  }

  const summary = aggregateUsage(records, {
    window,
    metric,
    now: Date.now(),
    model: values.model,
  });

  if (summary.filteredCount === 0) {
    const scope = values.model ? ` for model "${values.model}"` : "";
    console.log(`\n  No usage data${scope} in the ${windowLabel(window)}.\n`);
    return;
  }

  render(summary);
}

export { main };
