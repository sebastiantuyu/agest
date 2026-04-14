#!/usr/bin/env node

import { spawn } from "child_process";
import { main as stats } from "./stats.js";
import { main as preview } from "./preview.js";

const command = process.argv[2];

async function run() {
  const files = process.argv.slice(3);
  if (files.length === 0) {
    console.error("  Usage: agest run <file...>");
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
    run        Run test file(s)    agest run tests/*.test.ts
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
