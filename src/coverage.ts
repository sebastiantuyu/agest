import { readCheckpoints, wilsonInterval } from "./reports.js";
import { loadConfig } from "./config.js";
import { resolveAreas, CATALOG } from "./areas.js";
import { renderRadar, type RadarAxis } from "./braille.js";
import { c } from "./logger.js";
import type { AreaCoverage, CheckpointRecord } from "./types.js";

/**
 * `agest coverage` — the agent-testing equivalent of code coverage. Read-only:
 * it aggregates per-area data already persisted on checkpoints (never re-runs
 * tests), grouped per RUN (sweepId), and reports which capability areas are
 * covered, with what confidence, and — the key signal — what's missing.
 */

const W = 62;
const useColor = !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
const paint = (fn: (s: string) => string, s: string) => (useColor ? fn(s) : s);

function bar(value: number, max: number, width = 16): string {
  if (max <= 0) return "░".repeat(width);
  const filled = Math.min(width, Math.round((value / max) * width));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0).padStart(3)}%`;
}

/** Group key for "one run": the sweep id, falling back to the per-agent runId. */
export function sweepKey(rec: CheckpointRecord): string {
  return rec.sweepId ?? rec.runId;
}

export interface Sweep {
  key: string;
  records: CheckpointRecord[];
  timestamp: string; // latest in the group
}

export function groupSweeps(records: CheckpointRecord[]): Sweep[] {
  const map = new Map<string, CheckpointRecord[]>();
  for (const rec of records) {
    const k = sweepKey(rec);
    const arr = map.get(k) ?? [];
    arr.push(rec);
    map.set(k, arr);
  }
  return [...map.entries()]
    .map(([key, recs]) => ({
      key,
      records: recs,
      timestamp: recs.reduce((max, r) => (r.timestamp > max ? r.timestamp : max), recs[0].timestamp),
    }))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)); // newest first
}

/** Sum AreaCoverage entries by id (across a sweep's agent() records / suites). */
export function mergeAreas(entries: AreaCoverage[]): Map<string, AreaCoverage> {
  const m = new Map<string, AreaCoverage>();
  for (const a of entries) {
    const e = m.get(a.id);
    if (!e) {
      m.set(a.id, { ...a });
      continue;
    }
    e.scenes += a.scenes;
    e.passed += a.passed;
    e.trials += a.trials;
    e.trialPasses += a.trialPasses;
    e.inCatalog = e.inCatalog || a.inCatalog;
    e.minScenes = e.minScenes ?? a.minScenes;
  }
  // Derive passRate from the summed counts — never trust a per-entry rate.
  for (const e of m.values()) e.passRate = e.scenes > 0 ? e.passed / e.scenes : 0;
  return m;
}

function rateColor(rate: number): (s: string) => string {
  return rate >= 0.95 ? c.green : rate >= 0.5 ? c.yellow : c.red;
}

/** Confidence from sample breadth + the Wilson interval width. */
function confidenceLabel(a: AreaCoverage): { text: string; color: (s: string) => string } {
  if (a.scenes === 0) return { text: "⚠ no scenes — area untested", color: c.red };
  const { low, high } = wilsonInterval(a.trialPasses, a.trials);
  const ci = Math.round(((high - low) / 2) * 100);
  if (a.minScenes != null && a.scenes < a.minScenes) {
    return { text: `low confidence (CI ±${ci}%)`, color: c.yellow };
  }
  return { text: `ok (CI ±${ci}%)`, color: c.green };
}

function sectionHeader(title: string): void {
  console.log(`\n  ${paint(c.bold, title)}`);
  console.log("  " + "─".repeat(W - 2));
}

function printList(sweeps: Sweep[]): void {
  console.log("\n" + "━".repeat(W));
  console.log(`  AGEST COVERAGE  ·  ${sweeps.length} run${sweeps.length !== 1 ? "s" : ""}`);
  console.log("━".repeat(W));
  for (const s of sweeps) {
    const names = [...new Set(s.records.map((r) => r.agentName).filter(Boolean))].join(", ") || "—";
    const cases = s.records.reduce((sum, r) => sum + r.totalCases, 0);
    const shortKey = s.key.length > 22 ? s.key.slice(0, 21) + "…" : s.key;
    console.log(
      `  ${paint(c.cyan, shortKey.padEnd(22))}  ${paint(c.dim, s.timestamp)}  ${names}  ${paint(c.dim, `(${s.records.length} run${s.records.length !== 1 ? "s" : ""}, ${cases} cases)`)}`,
    );
  }
  console.log("");
}

/**
 * Build a braille radar of the sweep: one axis per opted-in area that has data,
 * the spoke length = the area's PASS RATE so the geometry matches the labeled %.
 * Dynamic — areas with no scenes are dropped entirely rather than pinned to the
 * centre, so the polygon stays meaningful. Needs ≥3 tested axes to render.
 */
export function renderAreaRadar(rollup: Map<string, AreaCoverage>, expected: Map<string, number | undefined>): string {
  const axes: RadarAxis[] = [...expected.keys()]
    .sort()
    .map((id) => ({ id, a: rollup.get(id) }))
    .filter((x): x is { id: string; a: AreaCoverage } => x.a != null && x.a.scenes > 0)
    .map(({ id, a }) => ({
      label: id.toUpperCase().slice(0, 11),
      value: a.passRate,
      note: `${Math.round(a.passRate * 100)}%`,
    }));
  if (axes.length < 3) return ""; // a radar needs ≥3 axes
  return renderRadar(axes, { color: useColor, ky: 1.1, fill: false });
}

/**
 * Compact metadata block. The radar omits untested areas by design, so this is
 * where the "what's missing" signal lives — plus domain tags and untagged scenes.
 */
function renderMetadata(rollup: Map<string, AreaCoverage>, expected: Map<string, number | undefined>, untagged: number): void {
  const ids = [...expected.keys()];
  const has = (id: string) => (rollup.get(id)?.scenes ?? 0) > 0;
  const tested = ids.filter(has).sort();
  const missing = ids.filter((id) => !has(id)).sort();
  const domain = [...rollup.values()].filter((a) => !a.inCatalog && a.scenes > 0).map((a) => a.id).sort();

  sectionHeader("Areas");
  console.log(`  ${"tested".padEnd(13)}${paint(c.green, `${tested.length}/${ids.length}`)}  ${paint(c.dim, tested.join(", ") || "—")}`);
  if (missing.length) console.log(`  ${"untested".padEnd(13)}${paint(c.red, missing.join(", "))}`);
  if (domain.length) console.log(`  ${"domain tags".padEnd(13)}${paint(c.dim, domain.join(", "))}`);
  if (untagged > 0) console.log(`  ${"untagged".padEnd(13)}${paint(c.dim, `${untagged} scene${untagged !== 1 ? "s" : ""}`)}`);
}

/** The detailed per-suite + roll-up bars, shown only with --full. */
function renderDetail(sweep: Sweep, rollup: Map<string, AreaCoverage>, expected: Map<string, number | undefined>): void {
  const suiteMap = new Map<string, AreaCoverage[]>();
  for (const rec of sweep.records) {
    for (const s of rec.areaCoverageBySuite ?? []) {
      const arr = suiteMap.get(s.suite) ?? [];
      arr.push(...s.areas);
      suiteMap.set(s.suite, arr);
    }
  }

  for (const [suite, areas] of [...suiteMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const merged = [...mergeAreas(areas).values()].sort((a, b) => a.id.localeCompare(b.id));
    if (merged.length === 0) continue;
    sectionHeader(`Suite: ${suite}`);
    for (const a of merged) {
      const label = a.id.slice(0, 20).padEnd(20);
      const display = `${paint(rateColor(a.passRate), pct(a.passRate))}  ${paint(c.dim, `${a.scenes} sc`)}`;
      console.log(`  ${label}  ${bar(a.passRate, 1)}  ${display}`);
    }
  }

  const ids = new Set<string>([
    ...expected.keys(),
    ...[...rollup.values()].filter((a) => a.inCatalog && a.scenes > 0).map((a) => a.id),
  ]);
  if (ids.size > 0) {
    sectionHeader("Coverage  (vs opted-in areas)");
    for (const id of [...ids].sort()) {
      const a: AreaCoverage = rollup.get(id) ?? {
        id,
        scenes: 0,
        passed: 0,
        passRate: 0,
        trials: 0,
        trialPasses: 0,
        inCatalog: id in CATALOG,
        minScenes: expected.get(id) ?? CATALOG[id]?.minScenes,
      };
      if (a.minScenes == null) a.minScenes = expected.get(id) ?? CATALOG[id]?.minScenes;
      const conf = confidenceLabel(a);
      const label = id.slice(0, 20).padEnd(20);
      if (a.scenes === 0) {
        console.log(`  ${label}  ${bar(0, 1)}  ${paint(conf.color, conf.text)}`);
        continue;
      }
      const target = a.minScenes != null ? `${a.scenes}/${a.minScenes}` : `${a.scenes}`;
      const display = `${paint(rateColor(a.passRate), pct(a.passRate))}  ${paint(c.dim, `${target} scenes`)} · ${paint(conf.color, conf.text)}`;
      console.log(`  ${label}  ${bar(a.passRate, 1)}  ${display}`);
    }
  }
}

function renderSweep(sweep: Sweep, expected: Map<string, number | undefined>, full: boolean): void {
  const rollup = mergeAreas(sweep.records.flatMap((r) => r.areaCoverage ?? []));
  const untagged = sweep.records.reduce((sum, r) => sum + (r.untaggedCount ?? 0), 0);

  // Compact one-line identity (the old multi-line banner wasted vertical space).
  const shortKey = sweep.key.length > 14 ? sweep.key.slice(0, 13) + "…" : sweep.key;
  const when = sweep.timestamp.replace("T", " ").slice(0, 16);
  const n = sweep.records.length;
  console.log(
    `\n  ${paint(c.bold, "coverage")}  ${paint(c.dim, `· run ${shortKey} · ${when} · ${n} run${n !== 1 ? "s" : ""}`)}`,
  );

  // Radar is the default centrepiece.
  const chart = renderAreaRadar(rollup, expected);
  if (chart) {
    sectionHeader("Area radar  (spoke = pass rate)");
    for (const line of chart.split("\n")) console.log("  " + line);
  } else {
    console.log(`\n  ${paint(c.dim, "Not enough tested areas for a radar (need ≥3 with data).")}`);
  }

  renderMetadata(rollup, expected, untagged);

  if (full) renderDetail(sweep, rollup, expected);

  if (!full) console.log(`\n  ${paint(c.dim, "--full for per-suite detail")}`);
}

/**
 * Interactive run browser: redraw on each keypress and arrow between sweeps so
 * you never copy/paste a sweep id. Resolves when the user quits (q / Ctrl-C).
 * Only entered for a TTY — callers gate on `process.stdin.isTTY`.
 */
function browseSweeps(sweeps: Sweep[], expected: Map<string, number | undefined>, initialFull: boolean): Promise<void> {
  let idx = 0;
  let full = initialFull;

  const draw = () => {
    process.stdout.write("\x1b[2J\x1b[H"); // clear screen + home
    renderSweep(sweeps[idx], expected, full);
    const nav = `[${idx + 1}/${sweeps.length}]  ← prev · → next · f ${full ? "hide" : "show"} detail · q quit`;
    console.log(`  ${paint(c.dim, nav)}\n`);
  };

  return new Promise<void>((resolve) => {
    const stdin = process.stdin;
    const finish = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve();
    };
    const onData = (key: string) => {
      switch (key) {
        case "\u0003": // Ctrl-C
        case "\u001b": // Esc
        case "q":
          finish();
          break;
        case "\x1b[C": // →
        case "l":
        case "n":
          idx = (idx + 1) % sweeps.length;
          draw();
          break;
        case "\x1b[D": // ←
        case "h":
        case "p":
          idx = (idx - 1 + sweeps.length) % sweeps.length;
          draw();
          break;
        case "f":
          full = !full;
          draw();
          break;
      }
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    draw();
  });
}

async function main(args: string[] = []): Promise<void> {
  const cwd = process.cwd();

  const all = await readCheckpoints(cwd);
  const withAreas = all.filter((r) => r.areaCoverage && r.areaCoverage.length > 0);

  if (withAreas.length === 0) {
    console.log(
      "\n  No area coverage found. Tag scenes with `.tags(...)` and run them, then try again.\n",
    );
    return;
  }

  const sweeps = groupSweeps(withAreas);

  if (args.includes("--list")) {
    printList(sweeps);
    return;
  }

  // Expected (opted-in) set from the CURRENT config, so areas newly added to
  // config surface as missing even before a run covers them. When config
  // declares none, fall back to the union persisted across the runs.
  const config = await loadConfig();
  const { optedIn } = resolveAreas(config.areas);
  const expected = new Map<string, number | undefined>();
  for (const [id, spec] of optedIn) expected.set(id, spec.minScenes);
  if (expected.size === 0) {
    for (const s of sweeps)
      for (const rec of s.records)
        for (const id of rec.areasOptedIn ?? []) if (!expected.has(id)) expected.set(id, CATALOG[id]?.minScenes);
  }

  const full = args.includes("--full");

  // --run <id>: render one specific run and exit.
  const runIdx = args.indexOf("--run");
  if (runIdx !== -1) {
    const want = args[runIdx + 1];
    const sweep =
      sweeps.find((s) => s.key === want || s.records.some((r) => r.runId === want)) ??
      sweeps.find((s) => s.key.startsWith(want ?? "\0"));
    if (!sweep) {
      console.log(`\n  No run found matching "${want}". Try \`agest coverage --list\`.\n`);
      return;
    }
    renderSweep(sweep, expected, full);
    return;
  }

  // Default in an interactive terminal: stay open and arrow between runs so the
  // sweep id never has to be copy/pasted. Piped/CI (no TTY), a single run, or
  // --once fall back to a one-shot render of the latest run.
  const interactive = !args.includes("--once") && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && sweeps.length > 1;
  if (interactive) {
    await browseSweeps(sweeps, expected, full);
    return;
  }
  renderSweep(sweeps[0], expected, full);
}

export { main };
