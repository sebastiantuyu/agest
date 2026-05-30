#!/usr/bin/env node

import { spawn } from "child_process";
import { fileURLToPath } from "node:url";
import { realpathSync, mkdtempSync, mkdirSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { main as stats } from "./stats.js";
import { main as preview } from "./preview.js";
import { DEFAULT_PATTERN, discoverTestFiles } from "./discover.js";
import { c } from "./logger.js";
import type { CheckpointRecord } from "./types.js";

/**
 * One record per `agent()` run, appended by the child process (see
 * AgentContext.execute → AGEST_SUMMARY_FILE). The parent reads them all back to
 * print a vitest-style footer across files.
 */
interface RunSummaryRecord {
  file: string;
  name?: string;
  total: number;
  passed: number;
  failed: number;
  duration: number;
  costUsd: number | null;
  /** Full checkpoint payload the parent appends to the canonical run log. */
  checkpoint?: CheckpointRecord;
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
  const targets: string[] = [];
  let pattern: string | undefined;
  let full = false;
  let record = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--pattern" || a === "-p") {
      pattern = args[++i];
      if (pattern === undefined) {
        console.error("  Error: --pattern requires a value");
        process.exit(1);
      }
    } else if (a.startsWith("--pattern=")) {
      pattern = a.slice("--pattern=".length);
    } else if (a === "--full") {
      full = true;
    } else if (a === "--record") {
      record = true;
    } else {
      targets.push(a);
    }
  }

  return { pattern, targets, full, record };
}

async function run(args: string[]) {
  const { pattern, targets, full, record } = parseRunArgs(args);
  const files = await discoverTestFiles(targets, { pattern });

  if (files.length === 0) {
    const effective = pattern ?? DEFAULT_PATTERN;
    console.error(`  No test files found (pattern: ${effective})`);
    process.exit(1);
  }

  // Each child appends a summary record here; the parent reads them back for
  // the aggregate footer. A unique dir keeps concurrent `agest run`s isolated.
  const summaryFile = join(mkdtempSync(join(tmpdir(), "agest-")), "summary.jsonl");
  // One sweepId per invocation groups every checkpoint row from this run.
  const sweepId = randomUUID();
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AGEST_SUMMARY_FILE: summaryFile,
    AGEST_SWEEP_ID: sweepId,
    // The test file renders its own output in a child process; propagate
    // --full so it emits the waterfall + full report rather than lean results.
    ...(full ? { AGEST_FULL: "1" } : {}),
    // Opt-in: persist a full per-scene YAML snapshot per agent() execution.
    ...(record ? { AGEST_RECORD: "1" } : {}),
  };

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
  writeCheckpoints(records);
  printRunSummary(records, files.length);
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

/**
 * The parent is the single writer of the canonical run log: append every
 * child's checkpoint record to `.reports/checkpoints.jsonl` in one buffer
 * (race-free across the spawned children). Best-effort — never break a run.
 */
function writeCheckpoints(records: RunSummaryRecord[]) {
  const checkpoints = records
    .map((r) => r.checkpoint)
    .filter((c): c is CheckpointRecord => c != null);
  if (checkpoints.length === 0) return;
  try {
    const dir = join(process.cwd(), ".reports");
    mkdirSync(dir, { recursive: true });
    const lines = checkpoints.map((c) => JSON.stringify(c)).join("\n") + "\n";
    appendFileSync(join(dir, "checkpoints.jsonl"), lines, "utf8");
  } catch {
    /* ignore */
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

function printUsage() {
  console.log(`
  Usage: agest <command>

  Commands:
    run        Run test file(s), directories, or glob patterns
               agest run tests/                       # walks for ${DEFAULT_PATTERN}
               agest run src/agest --pattern "**/*.test.ts"
               agest run "tests/**/*.agest.ts" path/to/file.agest.ts
               agest run tests/ --full                # also print waterfall + full report
               agest run tests/ --record              # also save a full per-scene snapshot
    stats      Show aggregated test statistics
               agest stats --suite <suiteHash>        # filter to one suite's history
               agest stats --export-csv [path]        # flatten the run log to CSV
    preview    Generate an HTML report preview
`);
}

const KNOWN_COMMANDS = new Set(["run", "stats", "preview"]);

export async function main(argv: string[]): Promise<void> {
  const command = argv[2];
  const commandArgs = getCommandArgs(argv);

  if (!command || !KNOWN_COMMANDS.has(command)) {
    printUsage();
    process.exit(command ? 1 : 0);
  }

  if (command === "run") {
    await run(commandArgs);
    return;
  }

  // stats/preview read their args from `process.argv.slice(2)`, so normalize
  // argv to drop the command word before handing off.
  process.argv = [argv[0], argv[1], ...commandArgs];
  if (command === "stats") await stats();
  else await preview();
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
