import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentReport } from "./types";

vi.mock("fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
}));

import { join } from "path";
import { formatReport, writeSnapshot, appendCheckpoint, writeDiffEntry } from "./reporter";
import type { CheckpointRecord } from "./types";
import { mkdir, writeFile, appendFile, access } from "fs/promises";

const mockedMkdir = vi.mocked(mkdir);
const mockedWriteFile = vi.mocked(writeFile);
const mockedAppendFile = vi.mocked(appendFile);
const mockedAccess = vi.mocked(access);

beforeEach(() => {
  vi.clearAllMocks();
  mockedMkdir.mockResolvedValue(undefined);
  mockedWriteFile.mockResolvedValue(undefined);
  mockedAppendFile.mockResolvedValue(undefined);
  mockedAccess.mockRejectedValue(new Error("ENOENT"));
  vi.spyOn(process, "cwd").mockReturnValue("/project");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const minimalReport: AgentReport = {
  successRate: 1,
  failedCases: [],
  failedCaseErrors: {},
  timestamp: "2024-01-01T00:00:00.000Z",
  duration: 1500,
  totalCases: 4,
  results: [],
};

describe("formatReport", () => {
  it("produces correct output for minimal report", () => {
    const output = formatReport(minimalReport);
    expect(output).toContain("agent:");
    expect(output).toContain('model: "unknown"');
    expect(output).toContain("success_rate: 1");
    expect(output).toContain("failed_cases_count: 0");
    expect(output).toContain("(none)");
    expect(output).toContain("total_cases: 4");
  });

  it("includes name when present", () => {
    const output = formatReport({ ...minimalReport, name: "test-agent" });
    expect(output).toContain('name: "test-agent"');
  });

  it("includes dimensions section", () => {
    const output = formatReport({
      ...minimalReport,
      dimensions: { model: "gpt-4", tools: "search" },
    });
    expect(output).toContain("dimensions:");
    expect(output).toContain('model: "gpt-4"');
    expect(output).toContain('tools: "search"');
  });

  it("emits an areas block with per-area coverage", () => {
    const output = formatReport({
      ...minimalReport,
      areaCoverage: [
        { id: "refusal", scenes: 2, passed: 1, passRate: 0.5, trials: 2, trialPasses: 1, inCatalog: true, minScenes: 5 },
        { id: "billing", scenes: 1, passed: 1, passRate: 1, trials: 1, trialPasses: 1, inCatalog: false },
      ],
      untaggedCount: 3,
    });
    expect(output).toContain("areas:");
    expect(output).toContain('- id: "refusal"');
    expect(output).toContain("success_rate: 0.5");
    expect(output).toContain("scenes: 2");
    expect(output).toContain("in_catalog: true");
    expect(output).toContain("min_scenes: 5");
    expect(output).toContain('- id: "billing"');
    expect(output).toContain("in_catalog: false");
    expect(output).toContain("untagged_scenes: 3");
  });

  it("omits the areas block when there is no area coverage", () => {
    expect(formatReport(minimalReport)).not.toContain("areas:");
  });

  it("lists failed cases with prompts and reasons", () => {
    const output = formatReport({
      ...minimalReport,
      failedCases: ["Q1", "Q2"],
      failedCaseErrors: { Q1: "Wrong", Q2: "Timeout" },
    });
    expect(output).toContain('- "Q1"');
    expect(output).toContain('reason: "Wrong"');
    expect(output).toContain('- "Q2"');
    expect(output).toContain('reason: "Timeout"');
  });

  it("includes token averages when present", () => {
    const output = formatReport({
      ...minimalReport,
      averageInputTokensPerCase: 100,
      averageOutputTokensPerCase: 50,
    });
    expect(output).toContain("average_input_tokens_per_case: 100");
    expect(output).toContain("average_output_tokens_per_case: 50");
  });

  it("omits token fields when undefined", () => {
    const output = formatReport(minimalReport);
    expect(output).not.toContain("average_input_tokens_per_case");
    expect(output).not.toContain("average_output_tokens_per_case");
  });

  it("renders a serialized preview for a value-only (structured) failed response", () => {
    const output = formatReport({
      ...minimalReport,
      successRate: 0,
      failedCases: ["Q1"],
      failedCaseErrors: { Q1: "structural mismatch" },
      results: [
        {
          prompt: "Q1",
          response: { value: { city: "Paris" } },
          duration: 5,
          passed: false,
          error: "structural mismatch",
        },
      ],
    });
    // Previously `response.text` was undefined for value-only responses and the
    // preview was dropped; now resolveText serializes the native value.
    expect(output).toContain('response: "{');
    expect(output).toContain("Paris");
  });

  it("shows model and hashes", () => {
    const output = formatReport({
      ...minimalReport,
      model: "gpt-4",
      systemPromptHash: "abc123",
      promptHash: "def456",
      tools: ["search"],
    });
    expect(output).toContain('model: "gpt-4"');
    expect(output).toContain("system_prompt: abc123");
    expect(output).toContain("prompt_hash: def456");
    expect(output).toContain('tools: ["search"]');
  });
});

describe("writeSnapshot", () => {
  it("creates .reports/runs/ directory with recursive: true", async () => {
    await writeSnapshot("content", "sweep-abcd1234");
    expect(mockedMkdir).toHaveBeenCalledWith(
      expect.stringContaining(join(".reports", "runs")),
      { recursive: true }
    );
  });

  it("writes content to a runId-named file (never clobbers)", async () => {
    await writeSnapshot("content", "sweep-abcd1234");
    expect(mockedWriteFile).toHaveBeenCalledWith(
      expect.stringContaining(join("runs", "sweep-abcd1234.yaml")),
      "content",
      "utf-8"
    );
  });

  it("returns the snapshot filepath", async () => {
    const path = await writeSnapshot("c", "local-deadbeef");
    expect(path).toContain(join(".reports", "runs", "local-deadbeef.yaml"));
  });

  it("does not warn — unique runIds mean no overwrite", async () => {
    mockedAccess.mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeSnapshot("c", "local-deadbeef");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("appendCheckpoint", () => {
  const record: CheckpointRecord = {
    runId: "local-deadbeef",
    timestamp: "2024-01-01T00:00:00.000Z",
    dimensions: { model: "gpt-4", suiteHash: "abc123" },
    totalCases: 3,
    casesPassed: 2,
    successRate: 0.67,
    durationMs: 1200,
  };

  it("creates the .reports/ directory", async () => {
    await appendCheckpoint(record);
    expect(mockedMkdir).toHaveBeenCalledWith(
      expect.stringContaining(".reports"),
      { recursive: true }
    );
  });

  it("appends one JSON line to checkpoints.jsonl", async () => {
    await appendCheckpoint(record);
    expect(mockedAppendFile).toHaveBeenCalledWith(
      expect.stringContaining(join(".reports", "checkpoints.jsonl")),
      JSON.stringify(record) + "\n",
      "utf-8"
    );
  });

  it("writes a single trailing-newline-terminated line", async () => {
    await appendCheckpoint(record);
    const written = mockedAppendFile.mock.calls[0][1] as string;
    expect(written.endsWith("\n")).toBe(true);
    expect(written.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(written.trimEnd())).toEqual(record);
  });
});

describe("writeDiffEntry", () => {
  it("creates .diff/ directory", async () => {
    await writeDiffEntry("abc123", "You are a helper", ["search"], "gpt-4");
    expect(mockedMkdir).toHaveBeenCalledWith(
      expect.stringContaining(".diff"),
      { recursive: true }
    );
  });

  it("writes YAML with system_prompt, tools, and model", async () => {
    await writeDiffEntry("abc123", "You are a helper", ["search"], "gpt-4");
    const written = mockedWriteFile.mock.calls[0][1] as string;
    expect(written).toContain("system_prompt: |");
    expect(written).toContain("  You are a helper");
    expect(written).toContain('tools: ["search"]');
    expect(written).toContain('model: "gpt-4"');
  });

  it("skips writing when file already exists", async () => {
    mockedAccess.mockResolvedValue(undefined);
    await writeDiffEntry("abc123", "prompt", [], "gpt-4");
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it("omits model line when model is undefined", async () => {
    await writeDiffEntry("abc123", "prompt", []);
    const written = mockedWriteFile.mock.calls[0][1] as string;
    expect(written).not.toContain("model:");
  });
});
