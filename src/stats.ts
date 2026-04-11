import { readdir, readFile } from "fs/promises";
import { join, relative } from "path";

interface ParsedReport {
  model: string;
  successRate: number;
  totalCases: number;
  duration: number;
  timestamp: string;
  averageInputTokensPerCase?: number;
  averageOutputTokensPerCase?: number;
  source: string;
}

function extractField(content: string, key: string): string | undefined {
  const regex = new RegExp(`^    ${key}:\\s*(.+)$`, "m");
  const match = content.match(regex);
  if (!match) return undefined;
  return match[1].replace(/^"|"$/g, "").trim();
}

function parseReport(content: string, source: string): ParsedReport {
  const num = (key: string, fallback = 0) =>
    parseFloat(extractField(content, key) ?? String(fallback));

  const avgIn = extractField(content, "average_input_tokens_per_case");
  const avgOut = extractField(content, "average_output_tokens_per_case");

  return {
    model: extractField(content, "model") ?? "unknown",
    successRate: num("success_rate"),
    totalCases: num("total_cases"),
    duration: num("duration"),
    timestamp: extractField(content, "timestamp") ?? "",
    averageInputTokensPerCase: avgIn != null ? parseFloat(avgIn) : undefined,
    averageOutputTokensPerCase: avgOut != null ? parseFloat(avgOut) : undefined,
    source,
  };
}

async function findReports(dir: string, depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  const SKIP = new Set(["node_modules", "dist", ".git", ".pnpm"]);
  const results: string[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "reports") {
        const files = await readdir(fullPath);
        for (const f of files) {
          if (f.endsWith(".yaml") || f.endsWith(".yml")) {
            results.push(join(fullPath, f));
          }
        }
      } else {
        results.push(...(await findReports(fullPath, depth + 1)));
      }
    }
  }
  return results;
}

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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(0).padStart(2, "0");
  return `${m}m${s}s`;
}

async function main() {
  const cwd = process.cwd();
  const files = await findReports(cwd);

  if (files.length === 0) {
    console.log("\n  No reports found. Run some agent tests first.\n");
    return;
  }

  const reports: ParsedReport[] = await Promise.all(
    files.map(async (f) => {
      const content = await readFile(f, "utf-8");
      return parseReport(content, relative(cwd, f));
    })
  );

  console.log("\n" + "━".repeat(W));
  console.log(
    `  AGEST STATS  ·  ${reports.length} report${reports.length !== 1 ? "s" : ""} found`
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

  console.log(
    "\n" +
    "━".repeat(W) +
    `\n  ${agg.length} model${agg.length !== 1 ? "s" : ""} · ${reports.length} total runs\n` +
    "━".repeat(W) +
    "\n"
  );
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
