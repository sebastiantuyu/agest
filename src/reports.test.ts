import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractField,
  parseFailedCases,
  parseDimensions,
  parseReport,
  formatDuration,
  computeDiff,
  diffConfigs,
  findControlledPairs,
  findVaryingDimensions,
  groupByDimension,
  findReports,
  loadDiffEntry,
  ensureDimensions,
  type ParsedReport,
  type DiffEntry,
} from "./reports";

// --- Pure function tests (no mocking) ---

describe("extractField", () => {
  it("extracts a simple field value", () => {
    const content = '    model: "gpt-4"';
    expect(extractField(content, "model")).toBe("gpt-4");
  });

  it("strips surrounding quotes from values", () => {
    const content = '    name: "my-agent"';
    expect(extractField(content, "name")).toBe("my-agent");
  });

  it("returns undefined when field is not present", () => {
    const content = '    model: "gpt-4"';
    expect(extractField(content, "name")).toBeUndefined();
  });

  it("handles unquoted values", () => {
    const content = "    success_rate: 0.85";
    expect(extractField(content, "success_rate")).toBe("0.85");
  });

  it("handles JSON array values", () => {
    const content = '    tools: ["search","calc"]';
    expect(extractField(content, "tools")).toBe('["search","calc"]');
  });
});

describe("parseFailedCases", () => {
  it("returns empty array when no failed_cases section exists", () => {
    expect(parseFailedCases("some content\nno section")).toEqual([]);
  });

  it("parses a single failed case with prompt", () => {
    const content = `    failed_cases:\n        - "What is 2+2?"`;
    expect(parseFailedCases(content)).toEqual([{ prompt: "What is 2+2?", reason: undefined }]);
  });

  it("parses a failed case with prompt AND reason", () => {
    const content = `    failed_cases:\n        - "What is 2+2?"\n          reason: "Wrong answer"`;
    expect(parseFailedCases(content)).toEqual([
      { prompt: "What is 2+2?", reason: "Wrong answer" },
    ]);
  });

  it("parses multiple failed cases", () => {
    const content = `    failed_cases:\n        - "Q1"\n          reason: "R1"\n        - "Q2"`;
    const result = parseFailedCases(content);
    expect(result).toHaveLength(2);
    expect(result[0].prompt).toBe("Q1");
    expect(result[1].prompt).toBe("Q2");
  });

  it("stops parsing when indentation breaks", () => {
    const content = `    failed_cases:\n        - "Q1"\n    next_field: value`;
    expect(parseFailedCases(content)).toHaveLength(1);
  });

  it("returns empty for (none) marker", () => {
    const content = `    failed_cases:\n        (none)`;
    expect(parseFailedCases(content)).toEqual([]);
  });
});

describe("parseDimensions", () => {
  it("returns undefined when no dimensions section exists", () => {
    expect(parseDimensions("no dimensions here")).toBeUndefined();
  });

  it("parses single dimension key-value pair", () => {
    const content = `    dimensions:\n        model: "gpt-4"`;
    expect(parseDimensions(content)).toEqual({ model: "gpt-4" });
  });

  it("parses multiple dimensions", () => {
    const content = `    dimensions:\n        model: "gpt-4"\n        tools: "search,calc"`;
    expect(parseDimensions(content)).toEqual({ model: "gpt-4", tools: "search,calc" });
  });

  it("stops parsing at next non-indented section", () => {
    const content = `    dimensions:\n        model: "gpt-4"\n    success_rate: 0.85`;
    expect(parseDimensions(content)).toEqual({ model: "gpt-4" });
  });
});

describe("parseReport", () => {
  const minimalReport = [
    "agent:",
    '    model: "gpt-4"',
    "    system_prompt: abc123",
    "    prompt_hash: def456",
    '    tools: ["search"]',
    "    success_rate: 0.75",
    "    failed_cases_count: 1",
    "    failed_cases:",
    '        - "test prompt"',
    '          reason: "failed"',
    '    timestamp: "2024-01-01T00:00:00.000Z"',
    "    duration: 1500",
    "    total_cases: 4",
  ].join("\n");

  it("parses a complete report", () => {
    const result = parseReport(minimalReport, "test.yaml");
    expect(result.model).toBe("gpt-4");
    expect(result.systemPromptHash).toBe("abc123");
    expect(result.promptHash).toBe("def456");
    expect(result.tools).toEqual(["search"]);
    expect(result.successRate).toBe(0.75);
    expect(result.failedCasesCount).toBe(1);
    expect(result.failedCases).toHaveLength(1);
    expect(result.timestamp).toBe("2024-01-01T00:00:00.000Z");
    expect(result.duration).toBe(1500);
    expect(result.totalCases).toBe(4);
    expect(result.source).toBe("test.yaml");
  });

  it("handles missing optional fields with fallbacks", () => {
    const content = "agent:\n    success_rate: 0\n    total_cases: 0\n    duration: 0";
    const result = parseReport(content, "s");
    expect(result.model).toBe("unknown");
    expect(result.name).toBeUndefined();
    expect(result.tools).toBeUndefined();
    expect(result.averageInputTokensPerCase).toBeUndefined();
    expect(result.averageOutputTokensPerCase).toBeUndefined();
  });

  it("parses token averages when present", () => {
    const content = minimalReport + "\n    average_input_tokens_per_case: 100\n    average_output_tokens_per_case: 50";
    const result = parseReport(content, "s");
    expect(result.averageInputTokensPerCase).toBe(100);
    expect(result.averageOutputTokensPerCase).toBe(50);
  });

  it("handles malformed tools JSON gracefully", () => {
    const content = "agent:\n    tools: not-json\n    success_rate: 0\n    total_cases: 0\n    duration: 0";
    const result = parseReport(content, "s");
    expect(result.tools).toBeUndefined();
  });
});

describe("formatDuration", () => {
  it("returns ms format for values < 1000", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(0)).toBe("0ms");
  });

  it("returns seconds format for values between 1000 and 60000", () => {
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(59999)).toBe("60.0s");
  });

  it("returns minutes format for values >= 60000", () => {
    expect(formatDuration(125000)).toBe("2m05s");
    expect(formatDuration(60000)).toBe("1m00s");
  });
});

describe("computeDiff", () => {
  const base: DiffEntry = { systemPrompt: "You are a helper", tools: ["search"], model: "gpt-4" };

  it("returns empty array when entries are identical", () => {
    expect(computeDiff(base, { ...base })).toEqual([]);
  });

  it("detects model change", () => {
    const b = { ...base, model: "gpt-3.5" };
    const lines = computeDiff(base, b);
    expect(lines).toContain('model: - "gpt-4"');
    expect(lines).toContain('model: + "gpt-3.5"');
  });

  it("detects added tools", () => {
    const b = { ...base, tools: ["search", "calc"] };
    const lines = computeDiff(base, b);
    expect(lines.some((l) => l.includes("+[calc]"))).toBe(true);
  });

  it("detects removed tools", () => {
    const b = { ...base, tools: [] };
    const lines = computeDiff(base, b);
    expect(lines.some((l) => l.includes("-[search]"))).toBe(true);
  });

  it("detects added prompt lines", () => {
    const b = { ...base, systemPrompt: "You are a helper\nNew instruction" };
    const lines = computeDiff(base, b);
    expect(lines.some((l) => l.startsWith("prompt: +"))).toBe(true);
  });

  it("detects removed prompt lines", () => {
    const b = { ...base, systemPrompt: "Different prompt" };
    const lines = computeDiff(base, b);
    expect(lines.some((l) => l.startsWith("prompt: -") || l.startsWith("prompt: +"))).toBe(true);
  });
});

describe("diffConfigs", () => {
  it("identifies all keys as held when configs are identical", () => {
    const c = { model: "gpt-4", tools: "search" };
    const result = diffConfigs(c, { ...c });
    expect(result.held).toEqual(c);
    expect(result.changedCount).toBe(0);
  });

  it("identifies differing keys as varied", () => {
    const result = diffConfigs({ model: "gpt-4" }, { model: "gpt-3.5" });
    expect(result.varied.model).toEqual({ from: "gpt-4", to: "gpt-3.5" });
    expect(result.changedCount).toBe(1);
  });

  it("handles keys present in only one config with (absent)", () => {
    const result = diffConfigs({ a: "1" }, { b: "2" });
    expect(result.varied.a).toEqual({ from: "1", to: "(absent)" });
    expect(result.varied.b).toEqual({ from: "(absent)", to: "2" });
  });
});

describe("findControlledPairs", () => {
  const makeReport = (dims: Record<string, string>, rate: number): ParsedReport => ({
    model: "gpt-4",
    successRate: rate,
    totalCases: 10,
    failedCasesCount: 0,
    failedCases: [],
    duration: 1000,
    timestamp: "2024-01-01",
    source: "test.yaml",
    dimensions: dims,
  });

  it("returns empty array when reports have no dimensions", () => {
    const r = makeReport({}, 0.5);
    r.dimensions = undefined;
    expect(findControlledPairs([r])).toEqual([]);
  });

  it("returns empty when no pair differs by exactly one dimension", () => {
    const a = makeReport({ model: "gpt-4", tools: "a" }, 0.5);
    const b = makeReport({ model: "gpt-3.5", tools: "b" }, 0.8);
    expect(findControlledPairs([a, b])).toEqual([]);
  });

  it("finds a pair differing by exactly one dimension", () => {
    const a = makeReport({ model: "gpt-4", tools: "search" }, 0.5);
    const b = makeReport({ model: "gpt-3.5", tools: "search" }, 0.8);
    const pairs = findControlledPairs([a, b]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].variedDimension).toBe("model");
    expect(pairs[0].delta).toBeCloseTo(0.3);
  });

  it("sorts by absolute delta descending", () => {
    const a = makeReport({ model: "a", tools: "x" }, 0.5);
    const b = makeReport({ model: "b", tools: "x" }, 0.6);
    const c = makeReport({ model: "c", tools: "x" }, 1.0);
    const pairs = findControlledPairs([a, b, c]);
    expect(Math.abs(pairs[0].delta)).toBeGreaterThanOrEqual(Math.abs(pairs[1].delta));
  });
});

describe("findVaryingDimensions", () => {
  const makeReport = (dims: Record<string, string>): ParsedReport => ({
    model: "x",
    successRate: 1,
    totalCases: 1,
    failedCasesCount: 0,
    failedCases: [],
    duration: 100,
    timestamp: "t",
    source: "s",
    dimensions: dims,
  });

  it("returns empty array when all reports have identical dimensions", () => {
    const r1 = makeReport({ model: "gpt-4" });
    const r2 = makeReport({ model: "gpt-4" });
    expect(findVaryingDimensions([r1, r2])).toEqual([]);
  });

  it("returns dimension names with more than one unique value", () => {
    const r1 = makeReport({ model: "gpt-4", tools: "a" });
    const r2 = makeReport({ model: "gpt-3.5", tools: "a" });
    expect(findVaryingDimensions([r1, r2])).toEqual(["model"]);
  });

  it("sorts by number of unique values descending", () => {
    const r1 = makeReport({ model: "a", tools: "x" });
    const r2 = makeReport({ model: "b", tools: "y" });
    const r3 = makeReport({ model: "c", tools: "y" });
    const result = findVaryingDimensions([r1, r2, r3]);
    expect(result[0]).toBe("model"); // 3 unique values
    expect(result[1]).toBe("tools"); // 2 unique values
  });

  it("skips reports without dimensions", () => {
    const r1 = makeReport({ model: "a" });
    const r2: ParsedReport = { ...makeReport({}), dimensions: undefined };
    expect(findVaryingDimensions([r1, r2])).toEqual([]);
  });
});

describe("groupByDimension", () => {
  const makeReport = (dims: Record<string, string>): ParsedReport => ({
    model: "x",
    successRate: 1,
    totalCases: 1,
    failedCasesCount: 0,
    failedCases: [],
    duration: 100,
    timestamp: "t",
    source: "s",
    dimensions: dims,
  });

  it("groups reports by the specified dimension value", () => {
    const r1 = makeReport({ model: "gpt-4" });
    const r2 = makeReport({ model: "gpt-4" });
    const r3 = makeReport({ model: "gpt-3.5" });
    const groups = groupByDimension([r1, r2, r3], "model");
    expect(groups.get("gpt-4")).toHaveLength(2);
    expect(groups.get("gpt-3.5")).toHaveLength(1);
  });

  it("uses '(unknown)' for reports missing the dimension", () => {
    const r1 = makeReport({ tools: "a" });
    const groups = groupByDimension([r1], "model");
    expect(groups.get("(unknown)")).toHaveLength(1);
  });
});

// --- FS-dependent tests (mocked) ---

vi.mock("fs/promises", () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

import { readdir, readFile } from "fs/promises";

const mockedReaddir = vi.mocked(readdir);
const mockedReadFile = vi.mocked(readFile);

describe("findReports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds .yaml files inside .reports/ directories", async () => {
    mockedReaddir.mockImplementation(async (dir: any, _opts?: any) => {
      if (dir === "/project") {
        return [{ name: ".reports", isDirectory: () => true }] as any;
      }
      if (dir === "/project/.reports") {
        return ["report-1.yaml", "report-2.yml"] as any;
      }
      return [];
    });

    const result = await findReports("/project");
    expect(result).toContain("/project/.reports/report-1.yaml");
    expect(result).toContain("/project/.reports/report-2.yml");
  });

  it("skips node_modules, dist, .git, .pnpm directories", async () => {
    mockedReaddir.mockImplementation(async (dir: any, _opts?: any) => {
      if (dir === "/project") {
        return [
          { name: "node_modules", isDirectory: () => true },
          { name: "dist", isDirectory: () => true },
          { name: ".git", isDirectory: () => true },
          { name: ".pnpm", isDirectory: () => true },
          { name: "src", isDirectory: () => true },
        ] as any;
      }
      return [];
    });

    await findReports("/project");
    // Should only recurse into src, not the skipped dirs
    const calledPaths = mockedReaddir.mock.calls.map((c) => c[0]);
    expect(calledPaths).not.toContain("/project/node_modules");
    expect(calledPaths).not.toContain("/project/dist");
  });

  it("returns empty array when readdir fails", async () => {
    mockedReaddir.mockRejectedValue(new Error("ENOENT"));
    expect(await findReports("/nonexistent")).toEqual([]);
  });
});

describe("loadDiffEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "cwd").mockReturnValue("/project");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads and parses a .diff/hash.yaml file", async () => {
    const content = `system_prompt: |\n  You are a helper\n  Be concise\ntools: ["search"]\nmodel: "gpt-4"`;
    mockedReadFile.mockResolvedValue(content as any);

    const result = await loadDiffEntry("abc123");
    expect(result).not.toBeNull();
    expect(result!.systemPrompt).toContain("You are a helper");
    expect(result!.tools).toEqual(["search"]);
    expect(result!.model).toBe("gpt-4");
  });

  it("returns null when file does not exist", async () => {
    mockedReadFile.mockRejectedValue(new Error("ENOENT"));
    expect(await loadDiffEntry("missing")).toBeNull();
  });

  it("handles missing model field", async () => {
    const content = `system_prompt: |\n  Hello\ntools: []`;
    mockedReadFile.mockResolvedValue(content as any);

    const result = await loadDiffEntry("abc");
    expect(result).not.toBeNull();
    expect(result!.model).toBeUndefined();
  });
});

describe("ensureDimensions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns existing dimensions if already set", async () => {
    const report: ParsedReport = {
      model: "gpt-4",
      successRate: 1,
      totalCases: 1,
      failedCasesCount: 0,
      failedCases: [],
      duration: 100,
      timestamp: "t",
      source: "s",
      dimensions: { model: "gpt-4", tools: "none" },
    };
    const result = await ensureDimensions(report);
    expect(result).toEqual({ model: "gpt-4", tools: "none" });
  });

  it("builds dimensions from model and tools when dimensions missing", async () => {
    const report: ParsedReport = {
      model: "gpt-4",
      successRate: 1,
      totalCases: 1,
      failedCasesCount: 0,
      failedCases: [],
      duration: 100,
      timestamp: "t",
      source: "s",
      tools: ["search", "calc"],
      promptHash: "abc123",
    };
    const result = await ensureDimensions(report);
    expect(result.model).toBe("gpt-4");
    expect(result.tools).toBe("calc,search"); // sorted
    expect(result.prompt).toBe("abc123");
  });

  it("sets tools dimension to 'none' when tools missing", async () => {
    const report: ParsedReport = {
      model: "gpt-4",
      successRate: 1,
      totalCases: 1,
      failedCasesCount: 0,
      failedCases: [],
      duration: 100,
      timestamp: "t",
      source: "s",
    };
    const result = await ensureDimensions(report);
    expect(result.tools).toBe("none");
  });
});
