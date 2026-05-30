import { describe, it, expect } from "vitest";
import { getCommandArgs, parseRunArgs, aggregateRunSummary } from "./cli.js";

const rec = (over: Partial<Parameters<typeof aggregateRunSummary>[0][number]> = {}) => ({
  file: "a.test.ts",
  name: undefined,
  total: 1,
  passed: 1,
  failed: 0,
  duration: 10,
  costUsd: null,
  ...over,
});

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

  it("defaults full to false", () => {
    const argv = ["node", "/abs/cli.js", "run", "tests/foo.agest.ts"];
    expect(parseRunArgs(getCommandArgs(argv)).full).toBe(false);
  });

  it("sets full when --full is passed, without treating it as a target", () => {
    const argv = ["node", "/abs/cli.js", "run", "--full", "tests/foo.agest.ts"];
    const parsed = parseRunArgs(getCommandArgs(argv));
    expect(parsed.full).toBe(true);
    expect(parsed.targets).toEqual(["tests/foo.agest.ts"]);
  });
});

describe("aggregateRunSummary", () => {
  it("hides the footer for a single scene in one file", () => {
    const s = aggregateRunSummary([rec({ total: 1, passed: 1 })], 1);
    expect(s.show).toBe(false);
  });

  it("shows the footer for one file with multiple scenes", () => {
    const s = aggregateRunSummary([rec({ total: 3, passed: 3 })], 1);
    expect(s.show).toBe(true);
    expect(s.totalCases).toBe(3);
  });

  it("shows the footer whenever more than one file ran", () => {
    const s = aggregateRunSummary(
      [rec({ file: "a.test.ts" }), rec({ file: "b.test.ts" })],
      2,
    );
    expect(s.show).toBe(true);
  });

  it("hides the footer when there are no records", () => {
    expect(aggregateRunSummary([], 0).show).toBe(false);
  });

  it("sums cases and counts a file failed when any of its scenes failed", () => {
    const s = aggregateRunSummary(
      [
        rec({ file: "a.test.ts", total: 2, passed: 2, failed: 0 }),
        rec({ file: "b.test.ts", total: 3, passed: 1, failed: 2 }),
      ],
      2,
    );
    expect(s.totalCases).toBe(5);
    expect(s.casesPassed).toBe(3);
    expect(s.casesFailed).toBe(2);
    expect(s.filesPassed).toBe(1);
    expect(s.filesFailed).toBe(1);
  });

  it("counts a discovered file that wrote no record as failed (crashed)", () => {
    // 3 files discovered, only 2 reported — the third crashed before reporting.
    const s = aggregateRunSummary(
      [rec({ file: "a.test.ts" }), rec({ file: "b.test.ts" })],
      3,
    );
    expect(s.filesFailed).toBe(1);
    expect(s.filesPassed).toBe(2);
  });

  it("totals duration and cost across records", () => {
    const s = aggregateRunSummary(
      [
        rec({ file: "a.test.ts", duration: 10, costUsd: 0.01 }),
        rec({ file: "b.test.ts", duration: 25, costUsd: 0.02 }),
      ],
      2,
    );
    expect(s.duration).toBe(35);
    expect(s.cost).toBeCloseTo(0.03);
  });
});
