import { readdir, readFile, rm } from "fs/promises";
import { join, relative } from "path";
import {
  type ParsedReport,
  parseReport,
  findReports,
  loadDiffEntry,
  computeDiff,
  formatDuration,
  ensureDimensions,
  findVaryingDimensions,
  groupByDimension,
  findControlledPairs,
  diffConfigs,
} from "./reports.js";

function avg(nums: number[]): number | undefined {
  return nums.length === 0
    ? undefined
    : nums.reduce((a, b) => a + b, 0) / nums.length;
}

function bar(value: number, max: number, width = 20): string {
  if (max === 0) return "░".repeat(width);
  const filled = Math.round((value / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

interface Row {
  label: string;
  value: number;
  display: string;
}

const W = 62;

function printSection(title: string, rows: Row[], max: number) {
  console.log(`\n  ${title}`);
  console.log("  " + "─".repeat(W - 2));
  for (const row of rows) {
    const label = row.label.slice(0, 26).padEnd(26);
    const b = bar(row.value, max);
    console.log(`  ${label}  ${b}  ${row.display}`);
  }
}

function formatDelta(prev: number, curr: number): string {
  const d = (curr - prev) * 100;
  if (Math.abs(d) < 0.5) return "  =  ";
  const sign = d > 0 ? "+" : "";
  return `${sign}${d.toFixed(0)}%`.padStart(5);
}

function shortDimLabel(dim: string, val: string, maxLen = 20): string {
  const short = val.length > maxLen ? val.slice(0, maxLen - 1) + "…" : val;
  return `${dim}:${short}`;
}

// ---------------------------------------------------------------------------
// Per-dimension evolution: group by held dims, show evolution along varied
// ---------------------------------------------------------------------------

async function printDimensionEvolution(
  name: string,
  runs: ParsedReport[],
  primaryDim: string,
  varyingDims: string[]
) {
  const groups = groupByDimension(runs, primaryDim);

  for (const [groupVal, groupRuns] of groups) {
    const sorted = [...groupRuns].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    console.log(`\n  ${name} / ${primaryDim}: ${groupVal}`);
    console.log("  " + "─".repeat(W - 2));

    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const runNum = `#${i + 1}`.padStart(3);
      const pct = `${(r.successRate * 100).toFixed(0).padStart(3)}%`;
      const b = bar(r.successRate, 1, 16);
      const delta = i === 0 ? "     " : formatDelta(sorted[i - 1].successRate, r.successRate);

      // Show other varying dimensions for this run
      const otherDims = varyingDims
        .filter((d) => d !== primaryDim)
        .map((d) => shortDimLabel(d, r.dimensions?.[d] ?? "?", 12))
        .join("  ");

      console.log(`  ${runNum}  ${b}  ${pct}  ${delta}  ${otherDims}`);

      // Show what changed from previous run (within this group)
      if (i > 0) {
        const prev = sorted[i - 1];
        const diff = diffConfigs(prev.dimensions ?? {}, r.dimensions ?? {});
        const changedLabels = Object.entries(diff.varied)
          .filter(([k]) => k !== primaryDim)
          .map(([k, v]) => `${k}: ${v.from} → ${v.to}`)
          .slice(0, 3);
        for (const l of changedLabels) {
          console.log(`        ${l}`);
        }

        // Show prompt diff if prompt changed
        if (diff.varied["prompt"] && prev.systemPromptHash && r.systemPromptHash) {
          const [prevEntry, currEntry] = await Promise.all([
            loadDiffEntry(prev.systemPromptHash),
            loadDiffEntry(r.systemPromptHash),
          ]);
          if (prevEntry && currEntry) {
            const promptDiff = computeDiff(prevEntry, currEntry)
              .filter((l) => l.startsWith("prompt:") || l.startsWith("tools:"));
            for (const l of promptDiff) console.log(`        ${l}`);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-dimension comparison
// ---------------------------------------------------------------------------

function printCrossComparison(name: string, runs: ParsedReport[], dim: string) {
  // Find configs that appear across multiple values of `dim`
  const otherDims = Object.keys(runs[0]?.dimensions ?? {}).filter((d) => d !== dim);
  const configKey = (r: ParsedReport) =>
    otherDims.map((d) => `${d}:${r.dimensions?.[d] ?? "?"}`).join("|");

  const byConfig = new Map<string, Map<string, ParsedReport>>();
  for (const r of runs) {
    const ck = configKey(r);
    const inner = byConfig.get(ck) ?? new Map();
    const dimVal = r.dimensions?.[dim] ?? "?";
    // Keep the latest run per (config, dimValue) pair
    const existing = inner.get(dimVal);
    if (!existing || new Date(r.timestamp) > new Date(existing.timestamp)) {
      inner.set(dimVal, r);
    }
    byConfig.set(ck, inner);
  }

  // Only show configs tested across 2+ values of the dimension
  const comparable = [...byConfig.entries()].filter(([, m]) => m.size > 1);
  if (comparable.length === 0) return;

  console.log(`\n  Cross-${dim} comparison: ${name}`);
  console.log("  " + "─".repeat(W - 2));

  for (const [ck, dimMap] of comparable) {
    const configLabel = ck
      .split("|")
      .map((s) => s.length > 30 ? s.slice(0, 29) + "…" : s)
      .join(" + ");
    console.log(`  ${configLabel}`);

    const entries = [...dimMap.entries()].sort(
      (a, b) => b[1].successRate - a[1].successRate
    );
    const best = entries[0][1].successRate;
    for (const [dimVal, r] of entries) {
      const pct = `${(r.successRate * 100).toFixed(0)}%`.padStart(4);
      const label = dimVal.length > 28 ? dimVal.slice(0, 27) + "…" : dimVal;
      const vs = r.successRate === best ? "" : `  (${((r.successRate - best) * 100).toFixed(0)}%)`;
      console.log(`    ${label.padEnd(30)} ${pct}${vs}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Attribution summary
// ---------------------------------------------------------------------------

function printAttribution(name: string, runs: ParsedReport[]) {
  const pairs = findControlledPairs(runs);
  if (pairs.length === 0) return;

  // Group by dimension
  const byDim = new Map<string, { deltas: number[]; examples: string[] }>();
  for (const p of pairs) {
    const entry = byDim.get(p.variedDimension) ?? { deltas: [], examples: [] };
    entry.deltas.push(p.delta);
    if (entry.examples.length < 2) {
      const d = (p.delta * 100).toFixed(0);
      const sign = p.delta > 0 ? "+" : "";
      entry.examples.push(`${p.variedFrom} → ${p.variedTo}: ${sign}${d}%`);
    }
    byDim.set(p.variedDimension, entry);
  }

  console.log(`\n  Dimension Impact: ${name}`);
  console.log("  " + "─".repeat(W - 2));

  const sorted = [...byDim.entries()].sort(
    (a, b) => Math.max(...b[1].deltas.map(Math.abs)) - Math.max(...a[1].deltas.map(Math.abs))
  );

  for (const [dim, { deltas, examples }] of sorted) {
    const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const sign = avgDelta > 0 ? "+" : "";
    const avgStr = `${sign}${(avgDelta * 100).toFixed(0)}%`;
    console.log(`  ${dim.padEnd(12)} ${avgStr.padStart(6)} avg  (${deltas.length} comparison${deltas.length !== 1 ? "s" : ""})`);
    for (const ex of examples) {
      console.log(`    ${ex}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------

async function purge(cwd: string) {
  const SKIP = new Set(["node_modules", "dist", ".git", ".pnpm"]);
  let count = 0;

  async function walk(dir: string, depth = 0) {
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".reports" || entry.name === ".diff") {
          await rm(fullPath, { recursive: true, force: true });
          console.log(`  removed  ${relative(cwd, fullPath)}/`);
          count++;
        } else if (!entry.name.startsWith(".")) {
          await walk(fullPath, depth + 1);
        }
      }
    }
  }

  await walk(cwd);
  console.log(`\n  Purged ${count} director${count !== 1 ? "ies" : "y"}.\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const agentFlagIdx = args.indexOf("--agent");
  const agentFilter = agentFlagIdx !== -1 ? args[agentFlagIdx + 1] : undefined;

  if (args.includes("--purge")) {
    await purge(process.cwd());
    return;
  }

  const cwd = process.cwd();
  const files = await findReports(cwd);

  if (files.length === 0) {
    console.log("\n  No reports found. Run some agent tests first.\n");
    return;
  }

  let reports: ParsedReport[] = await Promise.all(
    files.map(async (f) => {
      const content = await readFile(f, "utf-8");
      return parseReport(content, relative(cwd, f));
    })
  );

  // Ensure all reports have dimensions (backward compat)
  await Promise.all(reports.map((r) => ensureDimensions(r)));

  if (agentFilter) {
    reports = reports.filter(
      (r) => r.name?.toLowerCase() === agentFilter.toLowerCase()
    );
    if (reports.length === 0) {
      console.log(`\n  No reports found for agent "${agentFilter}".\n`);
      return;
    }
  }

  console.log("\n" + "━".repeat(W));
  const filterLabel = agentFilter ? `  ·  agent: ${agentFilter}` : "";
  console.log(
    `  AGEST STATS  ·  ${reports.length} report${reports.length !== 1 ? "s" : ""} found${filterLabel}`
  );
  console.log("━".repeat(W));

  // Aggregate by model
  const byModel = new Map<string, ParsedReport[]>();
  for (const r of reports) {
    const arr = byModel.get(r.model) ?? [];
    arr.push(r);
    byModel.set(r.model, arr);
  }

  const agg = [...byModel.entries()].map(([model, reps]) => {
    const inputNums = reps.flatMap((r) =>
      r.averageInputTokensPerCase != null ? [r.averageInputTokensPerCase] : []
    );
    const outputNums = reps.flatMap((r) =>
      r.averageOutputTokensPerCase != null ? [r.averageOutputTokensPerCase] : []
    );
    return {
      model,
      runs: reps.length,
      avgSuccessRate: avg(reps.map((r) => r.successRate))!,
      avgDuration: avg(reps.map((r) => r.duration))!,
      avgInputTokens: avg(inputNums),
      avgOutputTokens: avg(outputNums),
    };
  });

  agg.sort((a, b) => b.avgSuccessRate - a.avgSuccessRate);

  // Success rate (always shown)
  printSection(
    "Success Rate",
    agg.map((a) => ({
      label: `${a.model} (${a.runs}x)`,
      value: a.avgSuccessRate,
      display: `${(a.avgSuccessRate * 100).toFixed(0).padStart(3)}%`,
    })),
    1
  );

  // Token charts (only when data is present)
  const withTokens = agg.filter(
    (a) => a.avgInputTokens != null && a.avgOutputTokens != null
  );
  if (withTokens.length > 0) {
    const maxIn = Math.max(...withTokens.map((a) => a.avgInputTokens!));
    printSection(
      "Avg Input Tokens / Case",
      withTokens.map((a) => ({
        label: a.model,
        value: a.avgInputTokens!,
        display: String(Math.round(a.avgInputTokens!)).padStart(5),
      })),
      maxIn
    );

    const maxOut = Math.max(...withTokens.map((a) => a.avgOutputTokens!));
    printSection(
      "Avg Output Tokens / Case",
      withTokens.map((a) => ({
        label: a.model,
        value: a.avgOutputTokens!,
        display: String(Math.round(a.avgOutputTokens!)).padStart(5),
      })),
      maxOut
    );
  }

  // Duration chart — sorted fastest first (ascending)
  const byDuration = [...agg].sort((a, b) => a.avgDuration - b.avgDuration);
  const maxDuration = Math.max(...byDuration.map((a) => a.avgDuration));
  printSection(
    "Avg Duration / Run  (fastest first)",
    byDuration.map((a) => ({
      label: `${a.model} (${a.runs}x)`,
      value: a.avgDuration,
      display: formatDuration(a.avgDuration).padStart(8),
    })),
    maxDuration
  );

  // Dimension-aware evolution — named agents with more than one run
  const named = reports.filter((r) => r.name);
  const byAgentName = new Map<string, ParsedReport[]>();
  for (const r of named) {
    const arr = byAgentName.get(r.name!) ?? [];
    arr.push(r);
    byAgentName.set(r.name!, arr);
  }

  const evolvingAgents = [...byAgentName.entries()].filter(
    ([, runs]) => runs.length > 1
  );

  if (evolvingAgents.length > 0) {
    console.log(`\n  ${"─".repeat(W - 2)}`);
    console.log(`  EVOLUTION  ·  dimension-aware grouping`);

    for (const [name, runs] of evolvingAgents) {
      const varyingDims = findVaryingDimensions(runs);

      if (varyingDims.length === 0) {
        // All runs have identical config — just show flat timeline
        await printDimensionEvolution(name, runs, "model", []);
      } else {
        // Group by the primary varying dimension (most unique values)
        const primaryDim = varyingDims[0];
        await printDimensionEvolution(name, runs, primaryDim, varyingDims);

        // Cross-comparison for the primary varying dimension
        if (varyingDims.length >= 2) {
          printCrossComparison(name, runs, primaryDim);
        }
      }

      // Attribution summary from controlled pairs
      printAttribution(name, runs);
    }
  }

  console.log(
    "\n" +
    "━".repeat(W) +
    `\n  ${agg.length} model${agg.length !== 1 ? "s" : ""} · ${reports.length} total runs\n` +
    "━".repeat(W) +
    "\n"
  );
}

export { main };
