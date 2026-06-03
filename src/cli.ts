#!/usr/bin/env node

import { spawn } from "child_process";
import { fileURLToPath } from "node:url";
import { realpathSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { parseArgs } from "node:util";
import { main as stats } from "./stats.js";
import { main as usage } from "./usage.js";
import { main as coverage } from "./coverage.js";
import { main as preview } from "./preview.js";
import { DEFAULT_PATTERN, discoverTestFiles } from "./discover.js";
import { main as typegen, generateAreaTypesOnRun } from "./typegen.js";
import { finalizeSweep, gitInfo, agestVersion } from "./artifacts.js";
import { c } from "./logger.js";

/**
 * One footer line per `agent()` run, appended by the child process (see
 * AgentContext.execute → AGEST_SUMMARY_FILE). The parent reads them all back to
 * print a vitest-style cross-file footer. Checkpoints themselves are persisted
 * by the child as each run completes — not carried here.
 */
interface RunSummaryRecord {
  file: string;
  name?: string;
  total: number;
  passed: number;
  failed: number;
  duration: number;
  costUsd: number | null;
}

export interface ParsedRunArgs {
  pattern?: string;
  targets: string[];
  full: boolean;
  record: boolean;
}

/**
 * Extract the args that follow the command word from a full `process.argv`.
 * `argv = [execPath, scriptPath, command, ...commandArgs]`, so the command's
 * args always start at index 3. Capturing them here (once, from the original
 * argv) avoids re-slicing a mutated argv downstream — the double-shift that
 * silently dropped a lone `run` target and made discovery scan the whole cwd.
 */
export function getCommandArgs(argv: string[]): string[] {
  return argv.slice(3);
}

export function parseRunArgs(args: string[]): ParsedRunArgs {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: {
        pattern: { type: "string", short: "p" },
        full: { type: "boolean", default: false },
        record: { type: "boolean", default: false },
      },
      allowPositionals: true,
    }));
  } catch (err) {
    console.error(`  Error: ${(err as Error).message}`);
    process.exit(1);
  }

  return {
    pattern: values.pattern,
    targets: positionals,
    full: Boolean(values.full),
    record: Boolean(values.record),
  };
}

async function run(args: string[]) {
  const { pattern, targets, full, record } = parseRunArgs(args);
  const files = await discoverTestFiles(targets, { pattern });

  if (files.length === 0) {
    const effective = pattern ?? DEFAULT_PATTERN;
    console.error(`  No test files found (pattern: ${effective})`);
    process.exit(1);
  }

  await generateAreaTypesOnRun(process.cwd());

  const summaryFile = join(mkdtempSync(join(tmpdir(), "agest-")), "summary.jsonl");
  const sweepId = randomUUID();

  // One sweep folder, created here and shared with every child via AGEST_SWEEP_DIR.
  const startedAt = new Date().toISOString();
  const sweepDir = join(
    process.cwd(),
    ".reports",
    "sweeps",
    `${startedAt.replace(/[:.]/g, "-")}__${sweepId}`,
  );
  mkdirSync(sweepDir, { recursive: true });

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AGEST_SUMMARY_FILE: summaryFile,
    AGEST_SWEEP_ID: sweepId,
    AGEST_SWEEP_DIR: sweepDir,
    // Lets each child know it's part of a multi-file sweep so it can drop its
    // own "Running N scene…" header (the parent prints one below instead).
    AGEST_FILE_COUNT: String(files.length),
    // The test file renders its own output in a child process; propagate
    // --full so it emits the waterfall + full report rather than lean results.
    ...(full ? { AGEST_FULL: "1" } : {}),
    // Opt-in: persist a full per-scene YAML snapshot per agent() execution.
    ...(record ? { AGEST_RECORD: "1" } : {}),
  };

  if (files.length > 1) {
    console.log(c.bold(`\nRunning ${files.length} test files...`));
  }

  let anyChildCrashed = false;
  // Run every file (vitest-style) instead of bailing on the first failure, so
  // the footer reflects the whole run. Exit non-zero at the end if any failed.
  for (const file of files) {
    const child = spawn("npx", ["tsx", file], {
      stdio: "inherit",
      shell: true,
      env: childEnv,
    });

    const code = await new Promise<number>((resolve) =>
      child.on("close", (c) => resolve(c ?? 1))
    );

    // A non-zero code means the file itself threw/crashed. Failing scenes do
    // NOT surface here — the child resolves cleanly — so failure is read back
    // from the summary records below.
    if (code !== 0) anyChildCrashed = true;
  }

  const records = readSummary(summaryFile);
  printRunSummary(records, files.length);

  // Parent's closing pass: sweep manifest, FAILURES.md rollup, and `latest`.
  const summary = aggregateRunSummary(records, files.length);
  await finalizeSweep(sweepDir, {
    sweepId,
    timestamp: startedAt,
    agestVersion: agestVersion(),
    git: gitInfo(),
    files: files.length,
    totalCases: summary.totalCases,
    casesPassed: summary.casesPassed,
    casesFailed: summary.casesFailed,
    durationMs: summary.duration,
    totalCostUsd: summary.cost,
  });

  try {
    rmSync(dirname(summaryFile), { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }

  const casesFailed = records.reduce((sum, r) => sum + r.failed, 0);
  if (anyChildCrashed || casesFailed > 0) process.exit(1);
}

function readSummary(summaryFile: string): RunSummaryRecord[] {
  try {
    return readFileSync(summaryFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunSummaryRecord);
  } catch {
    return []; // no children wrote results (older lib, or all crashed early)
  }
}

export interface RunSummary {
  /** Whether the footer should print — false for a single scene in one file. */
  show: boolean;
  discoveredFiles: number;
  filesPassed: number;
  filesFailed: number;
  totalCases: number;
  casesPassed: number;
  casesFailed: number;
  duration: number;
  cost: number;
}

/**
 * Aggregate every child's records into the footer totals. The footer only
 * shows when more than one case ran (multiple files, or one file with multiple
 * scenes) — a single scene already prints its own one-line summary. A file
 * counts as failed if any of its agent() runs had a failing case, or if it
 * never wrote a record (crashed before reporting).
 */
export function aggregateRunSummary(
  records: RunSummaryRecord[],
  discoveredFiles: number,
): RunSummary {
  const totalCases = records.reduce((sum, r) => sum + r.total, 0);

  const failsByFile = new Map<string, number>();
  for (const r of records) {
    failsByFile.set(r.file, (failsByFile.get(r.file) ?? 0) + r.failed);
  }
  const missing = Math.max(0, discoveredFiles - failsByFile.size);
  const filesFailed = [...failsByFile.values()].filter((f) => f > 0).length + missing;

  const casesPassed = records.reduce((sum, r) => sum + r.passed, 0);

  return {
    show: records.length > 0 && (discoveredFiles > 1 || totalCases > 1),
    discoveredFiles,
    filesPassed: discoveredFiles - filesFailed,
    filesFailed,
    totalCases,
    casesPassed,
    casesFailed: totalCases - casesPassed,
    duration: records.reduce((sum, r) => sum + (r.duration || 0), 0),
    cost: records.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
  };
}

/**
 * Print the vitest-style footer. Delegates the math to aggregateRunSummary and
 * only renders when that says so.
 */
function printRunSummary(records: RunSummaryRecord[], discoveredFiles: number) {
  const s = aggregateRunSummary(records, discoveredFiles);
  if (!s.show) return;

  const tally = (failed: number, passed: number, total: number) =>
    failed > 0
      ? `${c.red(`${failed} failed`)} ${c.dim("|")} ${c.green(`${passed} passed`)} ${c.dim(`(${total})`)}`
      : `${c.green(`${passed} passed`)} ${c.dim(`(${total})`)}`;

  const line = (label: string, value: string) =>
    console.log(`${c.dim(label.padStart(11))}  ${value}`);

  console.log("");
  line("Test Files", tally(s.filesFailed, s.filesPassed, s.discoveredFiles));
  line("Tests", tally(s.casesFailed, s.casesPassed, s.totalCases));
  line("Duration", `${s.duration}ms`);
  if (s.cost > 0) line("Cost", c.green(`$${Number(s.cost.toFixed(4))}`));
}

/**
 * A CLI command. `run` receives the args that follow the command word (already
 * sliced by getCommandArgs), so a command never has to re-derive them from
 * process.argv. Adding a command = append one entry to COMMANDS below.
 */
interface Command {
  name: string;
  summary: string;
  /** Example invocation lines, shown under the command in the usage text. */
  usage?: string[];
  run(args: string[]): void | Promise<void>;
}

const COMMANDS: Command[] = [
  {
    name: "run",
    summary: "Run test file(s), directories, or glob patterns",
    usage: [
      `agest run tests/                       # walks for ${DEFAULT_PATTERN}`,
      `agest run src/agest --pattern "**/*.test.ts"`,
      `agest run "tests/**/*.agest.ts" path/to/file.agest.ts`,
      `agest run tests/ --full                # also print waterfall + full report`,
      `agest run tests/ --record              # also save a full per-scene snapshot`,
    ],
    run: run,
  },
  {
    name: "typegen",
    summary: "Generate agest-env.d.ts so scene().tags() checks your configured areas",
    usage: [
      `agest typegen                          # (re)write agest-env.d.ts from config`,
      `agest typegen --check                  # CI: exit non-zero if missing/stale`,
    ],
    run: typegen,
  },
  {
    name: "stats",
    summary: "Show aggregated test statistics",
    usage: [
      `agest stats --suite <suiteHash>        # filter to one suite's history`,
      `agest stats --export-csv [path]        # flatten the run log to CSV`,
    ],
    run: stats,
  },
  {
    name: "usage",
    summary: "Show token/cost usage over time",
    usage: [
      `agest usage                            # last 7 days, by tokens`,
      `agest usage --metric cost              # chart + breakdown by cost`,
      `agest usage --window 7d|30d|all        # pick the time window`,
      `agest usage --model <model>            # filter to one model`,
    ],
    run: usage,
  },
  {
    name: "coverage",
    summary: "Browse capability-area coverage radars; ←/→ to switch runs, q to quit",
    usage: [
      `agest coverage --once                  # one-shot render of the latest run`,
      `agest coverage --full                  # add per-suite + roll-up detail`,
      `agest coverage --list                  # list recent runs (sweeps)`,
      `agest coverage --run <sweepId>         # coverage for a specific run`,
    ],
    run: coverage,
  },
  {
    name: "preview",
    summary: "Generate an HTML report preview",
    run: preview,
  },
];

/** Dispatchable command names, derived from the registry (single source). */
export const KNOWN_COMMANDS = new Set(COMMANDS.map((cmd) => cmd.name));

function printUsage() {
  const lines = ["", "  Usage: agest <command>", "", "  Commands:"];
  const pad = Math.max(...COMMANDS.map((cmd) => cmd.name.length));
  for (const cmd of COMMANDS) {
    lines.push(`    ${cmd.name.padEnd(pad)}  ${cmd.summary}`);
    for (const ex of cmd.usage ?? []) {
      lines.push(`    ${" ".repeat(pad)}  ${c.dim(ex)}`);
    }
  }
  lines.push("");
  console.log(lines.join("\n"));
}

export async function main(argv: string[]): Promise<void> {
  const command = argv[2];
  const commandArgs = getCommandArgs(argv);

  const cmd = COMMANDS.find((c) => c.name === command);
  if (!cmd) {
    printUsage();
    process.exit(command ? 1 : 0);
  }

  await cmd.run(commandArgs);
}

// Only run as a CLI when invoked directly (bin or `tsx src/cli.ts`), not when
// imported by a test — that keeps `main` from firing (and calling
// process.exit) on import. Package managers expose the bin as a symlink
// (node_modules/.bin/agest), so argv[1] is the symlink path while
// import.meta.url is the real file; realpath both sides before comparing or
// the CLI silently no-ops when invoked through the symlink.
function isInvokedAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return entry === self;
  }
}
if (isInvokedAsCli()) {
  main(process.argv).catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
