#!/usr/bin/env node

import { spawn } from "child_process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { main as stats } from "./stats.js";
import { main as preview } from "./preview.js";
import { DEFAULT_PATTERN, discoverTestFiles } from "./discover.js";

export interface ParsedRunArgs {
  pattern?: string;
  targets: string[];
  full: boolean;
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
    } else {
      targets.push(a);
    }
  }

  return { pattern, targets, full };
}

async function run(args: string[]) {
  const { pattern, targets, full } = parseRunArgs(args);
  const files = await discoverTestFiles(targets, { pattern });

  if (files.length === 0) {
    const effective = pattern ?? DEFAULT_PATTERN;
    console.error(`  No test files found (pattern: ${effective})`);
    process.exit(1);
  }

  for (const file of files) {
    const child = spawn("npx", ["tsx", file], {
      stdio: "inherit",
      shell: true,
      // The test file renders its own output in a child process; propagate the
      // --full flag through the environment so it knows to emit the waterfall
      // and full report rather than just per-scene results.
      env: full ? { ...process.env, AGEST_FULL: "1" } : process.env,
    });

    const code = await new Promise<number>((resolve) =>
      child.on("close", (c) => resolve(c ?? 1))
    );

    if (code !== 0) process.exit(code);
  }
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
    stats      Show aggregated test statistics
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
