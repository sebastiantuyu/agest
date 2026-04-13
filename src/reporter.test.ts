import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentReport } from "./types";

vi.mock("fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(new Error("ENOENT")),
}));

import { formatReport, writeReport, writeDiffEntry } from "./reporter";
import { mkdir, writeFile, access } from "fs/promises";

const mockedMkdir = vi.mocked(mkdir);
const mockedWriteFile = vi.mocked(writeFile);
const mockedAccess = vi.mocked(access);

beforeEach(() => {
  vi.clearAllMocks();
  mockedMkdir.mockResolvedValue(undefined);
  mockedWriteFile.mockResolvedValue(undefined);
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

describe("writeReport", () => {
  it("creates .reports/ directory with recursive: true", async () => {
    await writeReport("content", "2024-01-01T00:00:00.000Z");
    expect(mockedMkdir).toHaveBeenCalledWith(
      expect.stringContaining(".reports"),
      { recursive: true }
    );
  });

  it("writes content to file", async () => {
    await writeReport("content", "2024-01-01T00:00:00.000Z");
    expect(mockedWriteFile).toHaveBeenCalledWith(
      expect.stringContaining(".reports"),
      "content",
      "utf-8"
    );
  });

  it("generates filename from timestamp when no dimensions", async () => {
    const path = await writeReport("c", "2024-01-01T00:00:00.000Z");
    expect(path).toContain("report-2024-01-01T00-00-00-000Z.yaml");
  });

  it("generates filename with dimension hash when dimensions present", async () => {
    const path = await writeReport("c", "2024-01-01", "agent", { model: "gpt-4" });
    expect(path).toMatch(/report-agent-[a-f0-9]+\.yaml$/);
  });

  it("includes name in filename", async () => {
    const path = await writeReport("c", "2024-01-01T00:00:00.000Z", "my-agent");
    expect(path).toContain("report-my-agent-");
  });

  it("sanitizes name for filename", async () => {
    const path = await writeReport("c", "2024-01-01T00:00:00.000Z", "my agent!");
    expect(path).toContain("report-my_agent_-");
  });

  it("warns when file already exists", async () => {
    mockedAccess.mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeReport("c", "2024-01-01T00:00:00.000Z", "test");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not warn when file is new", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeReport("c", "2024-01-01T00:00:00.000Z", "test");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns the filepath written", async () => {
    const path = await writeReport("c", "2024-01-01T00:00:00.000Z");
    expect(path).toContain(".reports/report-");
    expect(path).toContain(".yaml");
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
