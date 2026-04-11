import { createHash } from "crypto";
import { readdir, readFile } from "fs/promises";
import { join } from "path";

export interface ParsedReport {
  name?: string;
  systemPromptHash?: string;
  promptHash?: string;
  dimensions?: Record<string, string>;
  tools?: string[];
  model: string;
  successRate: number;
  totalCases: number;
  failedCasesCount: number;
  failedCases: Array<{ prompt: string; reason?: string }>;
  duration: number;
  timestamp: string;
  averageInputTokensPerCase?: number;
  averageOutputTokensPerCase?: number;
  source: string;
}

export interface DiffEntry {
  systemPrompt: string;
  tools: string[];
  model?: string;
}

export function extractField(content: string, key: string): string | undefined {
  const regex = new RegExp(`^    ${key}:\\s*(.+)$`, "m");
  const match = content.match(regex);
  if (!match) return undefined;
  return match[1].replace(/^"|"$/g, "").trim();
}

export function parseFailedCases(
  content: string
): Array<{ prompt: string; reason?: string }> {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) =>
    l.trimStart().startsWith("failed_cases:")
  );
  if (startIdx === -1) return [];
  const cases: Array<{ prompt: string; reason?: string }> = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("        ")) break;
    const promptMatch = line.match(/^\s+- "(.+)"$/);
    if (promptMatch) {
      const next = lines[i + 1];
      const reasonMatch = next?.match(/^\s+reason: "(.+)"$/);
      cases.push({ prompt: promptMatch[1], reason: reasonMatch?.[1] });
    }
  }
  return cases;
}

export function parseDimensions(content: string): Record<string, string> | undefined {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) => l.trimStart().startsWith("dimensions:"));
  if (startIdx === -1) return undefined;

  const dims: Record<string, string> = {};
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("        ")) break;
    const match = line.match(/^\s+(\w+):\s*"?(.+?)"?\s*$/);
    if (match) {
      dims[match[1]] = match[2];
    }
  }
  return Object.keys(dims).length > 0 ? dims : undefined;
}

export function parseReport(content: string, source: string): ParsedReport {
  const num = (key: string, fallback = 0) =>
    parseFloat(extractField(content, key) ?? String(fallback));

  const avgIn = extractField(content, "average_input_tokens_per_case");
  const avgOut = extractField(content, "average_output_tokens_per_case");

  const toolsRaw = extractField(content, "tools");
  const tools = toolsRaw
    ? (() => {
        try {
          return JSON.parse(toolsRaw) as string[];
        } catch {
          return undefined;
        }
      })()
    : undefined;

  const model = extractField(content, "model") ?? "unknown";
  const promptHash = extractField(content, "prompt_hash");
  const systemPromptHash = extractField(content, "system_prompt");
  const dimensions = parseDimensions(content);

  return {
    name: extractField(content, "name"),
    systemPromptHash,
    promptHash,
    dimensions,
    tools,
    model,
    successRate: num("success_rate"),
    totalCases: num("total_cases"),
    failedCasesCount: parseInt(
      extractField(content, "failed_cases_count") ?? "0",
      10
    ),
    failedCases: parseFailedCases(content),
    duration: num("duration"),
    timestamp: extractField(content, "timestamp") ?? "",
    averageInputTokensPerCase: avgIn != null ? parseFloat(avgIn) : undefined,
    averageOutputTokensPerCase: avgOut != null ? parseFloat(avgOut) : undefined,
    source,
  };
}

export async function findReports(dir: string, depth = 0): Promise<string[]> {
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
    if (SKIP.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".reports") {
        const files = await readdir(fullPath);
        for (const f of files) {
          if (f.endsWith(".yaml") || f.endsWith(".yml")) {
            results.push(join(fullPath, f));
          }
        }
      } else if (!entry.name.startsWith(".")) {
        results.push(...(await findReports(fullPath, depth + 1)));
      }
    }
  }
  return results;
}

export async function loadDiffEntry(hash: string): Promise<DiffEntry | null> {
  try {
    const content = await readFile(
      join(process.cwd(), ".diff", `${hash}.yaml`),
      "utf-8"
    );
    const promptMatch = content.match(
      /^system_prompt: \|\n([\s\S]*?)(?=\ntools:)/m
    );
    const toolsMatch = content.match(/^tools: (.+)$/m);
    const modelMatch = content.match(/^model: "(.+)"$/m);
    return {
      systemPrompt: promptMatch
        ? promptMatch[1].replace(/^  /gm, "").trimEnd()
        : "",
      tools: toolsMatch ? (JSON.parse(toolsMatch[1]) as string[]) : [],
      model: modelMatch ? modelMatch[1] : undefined,
    };
  } catch {
    return null;
  }
}

export function computeDiff(a: DiffEntry, b: DiffEntry): string[] {
  const lines: string[] = [];

  if (a.model !== b.model) {
    if (a.model) lines.push(`model: - "${a.model}"`);
    if (b.model) lines.push(`model: + "${b.model}"`);
  }

  const added = b.tools.filter((t) => !a.tools.includes(t));
  const removed = a.tools.filter((t) => !b.tools.includes(t));
  if (added.length) lines.push(`tools: +[${added.join(", ")}]`);
  if (removed.length) lines.push(`tools: -[${removed.join(", ")}]`);

  const aLines = new Set(
    a.systemPrompt.split("\n").map((l) => l.trim()).filter(Boolean)
  );
  const bLines = new Set(
    b.systemPrompt.split("\n").map((l) => l.trim()).filter(Boolean)
  );
  const addedLines = [...bLines].filter((l) => !aLines.has(l)).slice(0, 3);
  const removedLines = [...aLines].filter((l) => !bLines.has(l)).slice(0, 3);
  for (const l of addedLines) lines.push(`prompt: + "${l.slice(0, 60)}"`);
  for (const l of removedLines) lines.push(`prompt: - "${l.slice(0, 60)}"`);

  return lines;
}

// ---------------------------------------------------------------------------
// Dimension-agnostic analysis
// ---------------------------------------------------------------------------

export interface ConfigDiff {
  held: Record<string, string>;
  varied: Record<string, { from: string; to: string }>;
  changedCount: number;
}

export interface ControlledComparison {
  a: ParsedReport;
  b: ParsedReport;
  variedDimension: string;
  variedFrom: string;
  variedTo: string;
  delta: number;
}

/**
 * Reconstruct dimensions from legacy report fields (backward compat).
 * For old reports that lack the `dimensions` block, we build one from
 * model, promptHash (or systemPromptHash + diff entry), and tools.
 */
export async function ensureDimensions(report: ParsedReport): Promise<Record<string, string>> {
  if (report.dimensions) return report.dimensions;

  const dims: Record<string, string> = {};
  dims.model = report.model;

  if (report.promptHash) {
    dims.prompt = report.promptHash;
  } else if (report.systemPromptHash) {
    // Derive prompt-only hash from diff entry
    const entry = await loadDiffEntry(report.systemPromptHash);
    if (entry) {
      dims.prompt = createHash("sha256").update(entry.systemPrompt).digest("hex").slice(0, 12);
      report.promptHash = dims.prompt;
    }
  }

  if (report.tools?.length) {
    dims.tools = [...report.tools].sort().join(",");
  } else {
    dims.tools = "none";
  }

  report.dimensions = dims;
  return dims;
}

/**
 * Diff two config maps generically. Returns which dimensions were
 * held constant vs varied, without knowing what the dimensions are.
 */
export function diffConfigs(
  a: Record<string, string>,
  b: Record<string, string>
): ConfigDiff {
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const held: Record<string, string> = {};
  const varied: Record<string, { from: string; to: string }> = {};

  for (const key of allKeys) {
    const av = a[key] ?? "(absent)";
    const bv = b[key] ?? "(absent)";
    if (av === bv) {
      held[key] = av;
    } else {
      varied[key] = { from: av, to: bv };
    }
  }

  return { held, varied, changedCount: Object.keys(varied).length };
}

/**
 * Find all report pairs within the same agent where exactly one
 * dimension differs. These are "controlled comparisons" — the delta
 * can be cleanly attributed to the single varied dimension.
 */
export function findControlledPairs(reports: ParsedReport[]): ControlledComparison[] {
  const pairs: ControlledComparison[] = [];

  for (let i = 0; i < reports.length; i++) {
    for (let j = i + 1; j < reports.length; j++) {
      const a = reports[i];
      const b = reports[j];
      if (!a.dimensions || !b.dimensions) continue;

      const diff = diffConfigs(a.dimensions, b.dimensions);
      if (diff.changedCount !== 1) continue;

      const [dimName, { from, to }] = Object.entries(diff.varied)[0];
      pairs.push({
        a,
        b,
        variedDimension: dimName,
        variedFrom: from,
        variedTo: to,
        delta: b.successRate - a.successRate,
      });
    }
  }

  return pairs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

/**
 * Detect which dimensions vary across a set of reports.
 * Returns dimension names sorted by number of unique values (most varying first).
 */
export function findVaryingDimensions(reports: ParsedReport[]): string[] {
  const valuesByDim = new Map<string, Set<string>>();

  for (const r of reports) {
    if (!r.dimensions) continue;
    for (const [key, val] of Object.entries(r.dimensions)) {
      const set = valuesByDim.get(key) ?? new Set();
      set.add(val);
      valuesByDim.set(key, set);
    }
  }

  return [...valuesByDim.entries()]
    .filter(([, vals]) => vals.size > 1)
    .sort((a, b) => b[1].size - a[1].size)
    .map(([key]) => key);
}

/**
 * Group reports by the value of a specific dimension.
 */
export function groupByDimension(
  reports: ParsedReport[],
  dimension: string
): Map<string, ParsedReport[]> {
  const groups = new Map<string, ParsedReport[]>();
  for (const r of reports) {
    const val = r.dimensions?.[dimension] ?? "(unknown)";
    const arr = groups.get(val) ?? [];
    arr.push(r);
    groups.set(val, arr);
  }
  return groups;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(0).padStart(2, "0");
  return `${m}m${s}s`;
}
