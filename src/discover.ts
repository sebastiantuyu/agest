import { promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const DEFAULT_PATTERN = "**/*.agest.ts";

const GLOB_CHARS = /[*?[\]{}]/;

function hasGlobChars(value: string): boolean {
  return GLOB_CHARS.test(value);
}

async function statSafe(path: string): Promise<{ isFile: boolean; isDir: boolean }> {
  try {
    const stat = await fs.stat(path);
    return { isFile: stat.isFile(), isDir: stat.isDirectory() };
  } catch {
    return { isFile: false, isDir: false };
  }
}

async function expandGlob(pattern: string, cwd: string): Promise<string[]> {
  const out: string[] = [];
  // fs.promises.glob is available in Node >= 22 (the package's required engine).
  for await (const match of fs.glob(pattern, { cwd })) {
    out.push(isAbsolute(match) ? match : resolve(cwd, match));
  }
  return out;
}

export interface DiscoverOptions {
  pattern?: string;
  cwd?: string;
}

/**
 * Resolve a mix of file paths, directories, and glob patterns into a
 * deduplicated, sorted list of absolute file paths.
 *
 * Rules per target:
 *   - directory: search recursively for `pattern` (default `**\/*.agest.ts`)
 *   - glob (contains *, ?, [], {}): expand it
 *   - file: use as-is
 *   - anything else: try as glob (zero matches is fine)
 */
export async function discoverTestFiles(
  targets: string[],
  options: DiscoverOptions = {},
): Promise<string[]> {
  const cwd = options.cwd ?? process.cwd();
  const pattern = options.pattern ?? DEFAULT_PATTERN;
  const work = targets.length === 0 ? ["."] : targets;
  const found = new Set<string>();

  for (const target of work) {
    if (hasGlobChars(target)) {
      for (const f of await expandGlob(target, cwd)) found.add(f);
      continue;
    }

    const stat = await statSafe(isAbsolute(target) ? target : resolve(cwd, target));

    if (stat.isDir) {
      const trimmed = target.replace(/\/+$/, "");
      const dirPattern = `${trimmed}/${pattern}`;
      for (const f of await expandGlob(dirPattern, cwd)) found.add(f);
      continue;
    }

    if (stat.isFile) {
      found.add(isAbsolute(target) ? target : resolve(cwd, target));
      continue;
    }

    for (const f of await expandGlob(target, cwd)) found.add(f);
  }

  return [...found].sort();
}
