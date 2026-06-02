import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_PATTERN, discoverTestFiles } from "./discover.js";

let root: string;

async function touch(rel: string): Promise<string> {
  const full = join(root, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, "");
  return full;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agest-discover-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("discoverTestFiles", () => {
  it("walks a directory using the default pattern", async () => {
    const a = await touch("slot/dislikes.agest.ts");
    const b = await touch("slot/restrictions.agest.ts");
    await touch("slot/helper.ts");
    await touch("slot/notes.md");

    const found = await discoverTestFiles(["."], { cwd: root });
    expect(found).toEqual([a, b].sort());
  });

  it("recursively descends multiple levels", async () => {
    const a = await touch("a/b/c/deep.agest.ts");
    const b = await touch("top.agest.ts");

    const found = await discoverTestFiles(["."], { cwd: root });
    expect(found).toEqual([a, b].sort());
  });

  it("accepts a custom pattern", async () => {
    const a = await touch("foo.test.ts");
    await touch("bar.agest.ts");

    const found = await discoverTestFiles(["."], {
      cwd: root,
      pattern: "**/*.test.ts",
    });
    expect(found).toEqual([a]);
  });

  it("passes a specific file through unchanged", async () => {
    const a = await touch("solo.agest.ts");
    await touch("other.agest.ts");

    const found = await discoverTestFiles(["solo.agest.ts"], { cwd: root });
    expect(found).toEqual([a]);
  });

  it("expands an explicit glob pattern target", async () => {
    const a = await touch("pkg/one.agest.ts");
    const b = await touch("pkg/two.agest.ts");
    await touch("pkg/skip.ts");

    const found = await discoverTestFiles(["pkg/*.agest.ts"], { cwd: root });
    expect(found).toEqual([a, b].sort());
  });

  it("deduplicates files matched by multiple targets", async () => {
    const a = await touch("dup/case.agest.ts");

    const found = await discoverTestFiles(
      ["dup", "dup/case.agest.ts", "dup/*.agest.ts"],
      { cwd: root },
    );
    expect(found).toEqual([a]);
  });

  it("supports multiple directory targets", async () => {
    const a = await touch("alpha/x.agest.ts");
    const b = await touch("beta/y.agest.ts");
    await touch("gamma/z.agest.ts");

    const found = await discoverTestFiles(["alpha", "beta"], { cwd: root });
    expect(found).toEqual([a, b].sort());
  });

  it("defaults to cwd when given no targets", async () => {
    const a = await touch("root.agest.ts");
    const b = await touch("nested/inner.agest.ts");

    const found = await discoverTestFiles([], { cwd: root });
    expect(found).toEqual([a, b].sort());
  });

  it("returns an empty list when nothing matches", async () => {
    await touch("only.txt");

    const found = await discoverTestFiles(["."], { cwd: root });
    expect(found).toEqual([]);
  });

  it("returns sorted absolute paths", async () => {
    const z = await touch("z.agest.ts");
    const a = await touch("a.agest.ts");
    const m = await touch("m.agest.ts");

    const found = await discoverTestFiles(["."], { cwd: root });
    expect(found).toEqual([a, m, z]);
    for (const f of found) expect(f.startsWith("/")).toBe(true);
  });

  it("exposes DEFAULT_PATTERN as the conventional signature", () => {
    expect(DEFAULT_PATTERN).toBe("**/*.agest.ts");
  });
});
