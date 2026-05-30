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

export interface UsageTally {
  inTokens: number;
  outTokens: number;
  cost: number;
}

export interface UsageDayBucket extends UsageTally {
  day: string; // YYYY-MM-DD
  /** Per-model split within this day — feeds the stacked column chart. */
  models: Record<string, UsageTally>;
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

    const dayKey = localDayKey(ts);
    const day = byDay.get(dayKey) ?? { day: dayKey, inTokens: 0, outTokens: 0, cost: 0, models: {} };
    day.inTokens += inTok;
    day.outTokens += outTok;
    day.cost += cost;
    const dm = day.models[m] ?? { inTokens: 0, outTokens: 0, cost: 0 };
    dm.inTokens += inTok;
    dm.outTokens += outTok;
    dm.cost += cost;
    day.models[m] = dm;
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
const CHART_H = 8; // chart height in rows
const MAX_COLS = 48; // hard cap on columns before chunking kicks in

type ColorFn = (s: string) => string;

/** Stacked-chart palette — stable model→color by rank; past it, gray. */
const PALETTE: ColorFn[] = [c.cyan, c.green, c.yellow, c.magenta, c.blue, c.red];

function assignColors(models: string[]): Map<string, ColorFn> {
  const m = new Map<string, ColorFn>();
  models.forEach((model, i) => m.set(model, PALETTE[i] ?? c.gray));
  return m;
}

function bar(value: number, max: number, width = 24): string {
  if (max <= 0) return "░".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function windowLabel(window: UsageWindow): string {
  return window === "all" ? "all time" : `last ${WINDOW_DAYS[window]} days`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2025-05-07" → "May 7" */
function formatDayLabel(dayKey: string): string {
  const [, mo, d] = dayKey.split("-").map(Number);
  return `${MONTHS[(mo - 1) % 12]} ${d}`;
}

/**
 * Local calendar day for a timestamp. Checkpoints are stored UTC
 * (`new Date().toISOString()`); we bucket by the *local* day so the chart lines
 * up with the user's clock — a run at 23:00 UTC-3 lands on that local day, not
 * the next UTC one.
 */
function localDayKey(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Inclusive list of local YYYY-MM-DD from start to end. Steps by calendar day
 * via setDate (not +DAY_MS) so DST 23h/25h days don't skip or duplicate a day.
 */
function enumerateDays(startKey: string, endKey: string): string[] {
  const out: string[] = [];
  const [sy, sm, sd] = startKey.split("-").map(Number);
  const [ey, em, ed] = endKey.split("-").map(Number);
  const cur = new Date(sy, sm - 1, sd); // local midnight
  const end = new Date(ey, em - 1, ed).getTime();
  for (let i = 0; cur.getTime() <= end && i < 4000; i++) {
    out.push(localDayKey(cur.getTime()));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/** Color bars/legend unless the terminal opts out of color. */
function chartDisabled(): boolean {
  return Boolean(process.env.NO_COLOR) || process.env.TERM === "dumb";
}

interface Column {
  label: string; // first day of the (possibly chunked) range
  total: number; // chosen-metric total
  perModel: Map<string, number>;
}

/**
 * Build the continuous date axis (window-start → today), one column per day,
 * chunking contiguous days when the range is wider than the terminal so
 * `--window all` never overflows. Empty days survive as zero-height columns.
 */
function buildColumns(s: UsageSummary, now: number, modelOrder: string[]): Column[] {
  const byDay = new Map(s.days.map((d) => [d.day, d]));
  const earliest = s.days[0]?.day; // s.days is chronological
  const endKey = localDayKey(now);
  // For a fixed window, span the whole window (so sparse data still shows ~N
  // columns) but never start later than the earliest in-window day, so no
  // bucketed data falls off the left edge.
  const calStart =
    s.window === "all"
      ? (earliest ?? endKey)
      : localDayKey(now - (WINDOW_DAYS[s.window] - 1) * DAY_MS);
  const startKey = earliest && earliest < calStart ? earliest : calStart;
  const axis = enumerateDays(startKey, endKey);

  const termCols = process.stdout.columns ?? 80;
  const maxCols = Math.max(8, Math.min(MAX_COLS, termCols - 12));
  const chunk = Math.max(1, Math.ceil(axis.length / maxCols));

  const cols: Column[] = [];
  for (let i = 0; i < axis.length; i += chunk) {
    const slice = axis.slice(i, i + chunk);
    const perModel = new Map<string, number>();
    let total = 0;
    for (const dk of slice) {
      const b = byDay.get(dk);
      if (!b) continue;
      for (const model of modelOrder) {
        const t = b.models[model];
        if (!t) continue;
        const v = metricValue(t, s.metric);
        perModel.set(model, (perModel.get(model) ?? 0) + v);
        total += v;
      }
    }
    cols.push({ label: slice[0], total, perModel });
  }
  return cols;
}

/**
 * Date labels under the axis. The first (left-aligned) and last (right-aligned,
 * = today) are always anchored so the time range reads end-to-end; a couple of
 * evenly-spaced middle labels fill in when there's room. A label is skipped
 * rather than drawn over a neighbour, so nothing overlaps.
 */
function renderAxisLabels(cols: Column[], gutter: number): string {
  const n = cols.length;
  const line: string[] = new Array(n).fill(" ");

  const place = (idx: number, preferStart: number) => {
    const label = formatDayLabel(cols[idx].label);
    const start = Math.max(0, Math.min(preferStart, n - label.length));
    // Treat out-of-range cells (undefined) as free — a label may overflow a
    // very narrow axis; only a defined non-space cell counts as a collision.
    for (let k = 0; k < label.length; k++) {
      const cell = line[start + k];
      if (cell !== undefined && cell !== " ") return;
    }
    for (let k = 0; k < label.length; k++) line[start + k] = label[k];
  };

  if (n > 0) place(0, 0);
  if (n > 1) place(n - 1, n - formatDayLabel(cols[n - 1].label).length);
  const mids = n > 16 ? [Math.round(n / 3), Math.round((2 * n) / 3)] : n > 8 ? [Math.round(n / 2)] : [];
  for (const idx of mids) place(idx, idx);

  return `  ${" ".repeat(gutter)} ${c.dim(line.join(""))}`;
}

/**
 * Vertical stacked column chart over a continuous date axis. Each column is a
 * day (or chunk); each model a solid color. Segment heights use cumulative
 * rounding so they sum exactly to the column height (no drift).
 */
function renderVerticalChart(
  s: UsageSummary,
  now: number,
  colors: Map<string, ColorFn>,
  modelOrder: string[],
): void {
  const cols = buildColumns(s, now, modelOrder);
  const max = Math.max(0, ...cols.map((col) => col.total));
  const metricTitle = s.metric === "cost" ? "Cost" : "Tokens";

  const maxLabel = s.metric === "cost" ? formatCost(max) : formatTokens(max);
  const gw = Math.max(maxLabel.length, 1);

  const stacks = cols.map((col) => {
    const cells: (string | null)[] = new Array(CHART_H).fill(null);
    if (max > 0 && col.total > 0) {
      let running = 0;
      for (const model of modelOrder) {
        const v = col.perModel.get(model) ?? 0;
        if (v <= 0) continue;
        const lo = Math.round((running / max) * CHART_H);
        running += v;
        const hi = Math.round((running / max) * CHART_H);
        for (let r = lo; r < hi && r < CHART_H; r++) cells[r] = model;
      }
      // Guarantee an active column shows at least one cell.
      if (!cells.some(Boolean)) {
        const top = [...col.perModel.entries()].sort((a, b) => b[1] - a[1])[0];
        if (top) cells[0] = top[0];
      }
    }
    return cells;
  });

  console.log(`\n  ${metricTitle} per Day`);
  for (let r = CHART_H - 1; r >= 0; r--) {
    const label = r === CHART_H - 1 ? maxLabel : r === 0 ? "0" : "";
    const gutter = c.dim(label.padStart(gw));
    const row = stacks
      .map((cells) => {
        const model = cells[r];
        return model ? (colors.get(model) ?? c.gray)("█") : " ";
      })
      .join("");
    console.log(`  ${gutter} ${row}`);
  }
  console.log(renderAxisLabels(cols, gw));
}

/** Horizontal per-day bars — the no-color / dumb-terminal fallback. */
function renderHorizontalChart(s: UsageSummary): void {
  const metricTitle = s.metric === "cost" ? "Cost" : "Tokens";
  console.log(`\n  ${metricTitle} per Day`);
  console.log("  " + "─".repeat(W - 2));
  const maxDay = Math.max(0, ...s.days.map((d) => metricValue(d, s.metric)));
  for (const d of s.days) {
    const b = bar(metricValue(d, s.metric), maxDay);
    const val = formatMetric(d, s.metric).padStart(8);
    console.log(`  ${c.dim(d.day)}  ${b}  ${val}`);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(s: UsageSummary, now: number): void {
  const colors = assignColors(s.rows.map((r) => r.model));
  const modelOrder = s.rows.map((r) => r.model);

  console.log("\n" + "━".repeat(W));
  console.log(
    `  ${c.bold("AGEST USAGE")}  ${c.dim("·")}  ${s.totals.runs} run${s.totals.runs !== 1 ? "s" : ""}` +
      `  ${c.dim("·")}  ${c.dim(windowLabel(s.window))}  ${c.dim("·")}  ${c.dim(`metric: ${s.metric}`)}`,
  );
  console.log("━".repeat(W));

  if (chartDisabled()) renderHorizontalChart(s);
  else renderVerticalChart(s, now, colors, modelOrder);

  // Per-model breakdown — colored ● dot ties each model to its chart color.
  console.log(`\n  By Model`);
  console.log("  " + "─".repeat(W - 2));
  const grand = s.rows.reduce((sum, r) => sum + metricValue(r, s.metric), 0);
  for (const r of s.rows) {
    const pct = grand > 0 ? (metricValue(r, s.metric) / grand) * 100 : 0;
    const dot = (colors.get(r.model) ?? c.gray)("●");
    const head = `${dot} ${c.bold(r.model)} ${c.dim(`(${pct.toFixed(1)}%)`)}`;
    const detail =
      `In: ${formatTokens(r.inTokens)} ${c.dim("·")} Out: ${formatTokens(r.outTokens)}` +
      (s.hasCost ? ` ${c.dim("·")} ${formatCost(r.cost)}` : "") +
      ` ${c.dim(`· ${r.runs} run${r.runs !== 1 ? "s" : ""}`)}`;
    console.log(`  ${head}`);
    console.log(`      ${c.dim(detail)}`);
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
        window: { type: "string", default: "7d" },
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

  const now = Date.now();
  const summary = aggregateUsage(records, { window, metric, now, model: values.model });

  if (summary.filteredCount === 0) {
    const scope = values.model ? ` for model "${values.model}"` : "";
    console.log(`\n  No usage data${scope} in the ${windowLabel(window)}.\n`);
    return;
  }

  render(summary, now);
}

export { main };
