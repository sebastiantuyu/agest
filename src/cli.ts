#!/usr/bin/env node

import { spawn } from "child_process";
import { main as stats } from "./stats.js";
import { main as preview } from "./preview.js";
import { DEFAULT_PATTERN, discoverTestFiles } from "./discover.js";

const command = process.argv[2];

interface ParsedRunArgs {
  pattern?: string;
  targets: string[];
}

function parseRunArgs(args: string[]): ParsedRunArgs {
  const targets: string[] = [];
  let pattern: string | undefined;

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
    } else {
      targets.push(a);
    }
  }

  return { pattern, targets };
}

async function run() {
  const { pattern, targets } = parseRunArgs(process.argv.slice(3));
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
    });

    const code = await new Promise<number>((resolve) =>
      child.on("close", (c) => resolve(c ?? 1))
    );

    if (code !== 0) process.exit(code);
  }
}

const commands: Record<string, () => Promise<void>> = {
  stats,
  preview,
  run,
};

if (!command || !commands[command]) {
  console.log(`
  Usage: agest <command>

  Commands:
    run        Run test file(s), directories, or glob patterns
               agest run tests/                       # walks for ${DEFAULT_PATTERN}
               agest run src/agest --pattern "**/*.test.ts"
               agest run "tests/**/*.agest.ts" path/to/file.agest.ts
    stats      Show aggregated test statistics
    preview    Generate an HTML report preview
`);
  process.exit(command ? 1 : 0);
}

// Forward remaining args so subcommands see them at process.argv[2+]
process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];

commands[command]().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
