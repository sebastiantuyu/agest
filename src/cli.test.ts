import { describe, it, expect } from "vitest";
import { getCommandArgs, parseRunArgs } from "./cli.js";

/**
 * Regression coverage for the CLI arg plumbing. The original bug: `run` sliced
 * its args from an already-normalized argv, double-shifting and dropping the
 * first target. A single `agest run <file>` then resolved to zero targets and
 * discovery fell back to scanning the whole project. These tests exercise the
 * real flow — full argv → command args → parsed run args.
 */
describe("getCommandArgs", () => {
  it("returns the args following the command word", () => {
    const argv = ["node", "/abs/cli.js", "run", "tests/foo.agest.ts"];
    expect(getCommandArgs(argv)).toEqual(["tests/foo.agest.ts"]);
  });

  it("returns [] when only a command is present", () => {
    expect(getCommandArgs(["node", "/abs/cli.js", "run"])).toEqual([]);
  });
});

describe("parseRunArgs (via full argv)", () => {
  const targetsFor = (argv: string[]) => parseRunArgs(getCommandArgs(argv)).targets;

  it("keeps a single run target (regression: was dropped to [])", () => {
    const argv = ["node", "/abs/cli.js", "run", "tests/foo.agest.ts"];
    expect(targetsFor(argv)).toEqual(["tests/foo.agest.ts"]);
  });

  it("keeps every target when several are passed", () => {
    const argv = ["node", "/abs/cli.js", "run", "dirA", "dirB"];
    expect(targetsFor(argv)).toEqual(["dirA", "dirB"]);
  });

  it("separates --pattern from the target", () => {
    const argv = ["node", "/abs/cli.js", "run", "--pattern", "**/*.t.ts", "dir"];
    const parsed = parseRunArgs(getCommandArgs(argv));
    expect(parsed.pattern).toBe("**/*.t.ts");
    expect(parsed.targets).toEqual(["dir"]);
  });

  it("supports the --pattern=value form", () => {
    const argv = ["node", "/abs/cli.js", "run", "--pattern=**/*.spec.ts", "dir"];
    const parsed = parseRunArgs(getCommandArgs(argv));
    expect(parsed.pattern).toBe("**/*.spec.ts");
    expect(parsed.targets).toEqual(["dir"]);
  });

  it("yields no targets when none are given (caller scans cwd)", () => {
    const argv = ["node", "/abs/cli.js", "run"];
    expect(targetsFor(argv)).toEqual([]);
  });
});
