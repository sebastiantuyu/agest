import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

vi.mock("./config", () => ({
  loadConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock("./runner", () => ({
  executeScene: vi.fn().mockResolvedValue({
    prompt: "p",
    response: { text: "r" },
    duration: 100,
    passed: true,
  }),
}));

vi.mock("./reporter", () => ({
  formatReport: vi.fn().mockReturnValue("formatted"),
  writeSnapshot: vi.fn().mockResolvedValue("/project/.reports/runs/run.yaml"),
  appendCheckpoint: vi.fn().mockResolvedValue(undefined),
  writeDiffEntry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), write: vi.fn() },
  c: {
    bold: (s: string) => s,
    dim: (s: string) => s,
    green: (s: string) => s,
    red: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    gray: (s: string) => s,
  },
}));

import { SceneBuilder, AgentContext, setContext, getContext, hashPromptOnly } from "./context.js";
import { loadConfig } from "./config.js";
import { executeScene } from "./runner.js";
import { formatReport, appendCheckpoint, writeDiffEntry } from "./reporter.js";

const mockedLoadConfig = vi.mocked(loadConfig);
const mockedExecuteScene = vi.mocked(executeScene);
const mockedAppendCheckpoint = vi.mocked(appendCheckpoint);
const mockedWriteDiffEntry = vi.mocked(writeDiffEntry);

beforeEach(() => {
  vi.clearAllMocks();
  mockedLoadConfig.mockResolvedValue({});
  mockedExecuteScene.mockResolvedValue({
    prompt: "p",
    response: { text: "r" },
    duration: 100,
    passed: true,
  });
  delete process.env.AGEST_SUMMARY_FILE;
  delete process.env.AGEST_RECORD;
  setContext(null);
});

describe("hashPromptOnly", () => {
  it("returns a 12-char hex string", () => {
    const hash = hashPromptOnly("hello");
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });

  it("returns consistent hash for same input", () => {
    expect(hashPromptOnly("hello")).toBe(hashPromptOnly("hello"));
  });

  it("returns different hash for different input", () => {
    expect(hashPromptOnly("hello")).not.toBe(hashPromptOnly("world"));
  });
});

describe("setContext / getContext", () => {
  it("getContext throws when no context is set", () => {
    setContext(null);
    expect(() => getContext()).toThrow("scene() must be called inside an agent() callback");
  });

  it("getContext returns the context after setContext is called", () => {
    const ctx = new AgentContext(vi.fn(), "test");
    setContext(ctx);
    expect(getContext()).toBe(ctx);
  });

  it("setContext(null) clears the context", () => {
    setContext(new AgentContext(vi.fn()));
    setContext(null);
    expect(() => getContext()).toThrow();
  });
});

describe("SceneBuilder", () => {
  it("constructs with prompt string", () => {
    const builder = new SceneBuilder("test prompt");
    const def = builder.toDefinition();
    expect(def.prompt).toBe("test prompt");
  });

  it("timeout() sets timeout and returns this", () => {
    const builder = new SceneBuilder("p");
    const returned = builder.timeout(5000);
    expect(returned).toBe(builder);
    expect(builder.toDefinition().timeout).toBe(5000);
  });

  it("turns() sets turns and returns this", () => {
    const builder = new SceneBuilder("p");
    const returned = builder.turns(3);
    expect(returned).toBe(builder);
    expect(builder.toDefinition().turns).toBe(3);
  });

  it("tags() sets tags, merges on repeat, and returns this", () => {
    const builder = new SceneBuilder("p");
    const returned = builder.tags("refusal", "safety");
    expect(returned).toBe(builder);
    builder.tags("tool-use");
    expect(builder.toDefinition().tags).toEqual(["refusal", "safety", "tool-use"]);
  });

  it("toDefinition() omits tags when never set", () => {
    expect(new SceneBuilder("p").toDefinition().tags).toBeUndefined();
  });

  it("expect() pushes assertion and returns this", () => {
    const fn = vi.fn();
    const builder = new SceneBuilder("p");
    const returned = builder.expect("response", fn);
    expect(returned).toBe(builder);
    expect(builder.toDefinition().assertions).toHaveLength(1);
    expect(builder.toDefinition().assertions[0].field).toBe("response");
  });

  it("toDefinition() returns a copy of assertions array", () => {
    const builder = new SceneBuilder("p");
    builder.expect("response", vi.fn());
    const def1 = builder.toDefinition();
    const def2 = builder.toDefinition();
    expect(def1.assertions).not.toBe(def2.assertions);
    expect(def1.assertions).toEqual(def2.assertions);
  });

  it("chaining works: timeout + turns + expect", () => {
    const fn = vi.fn();
    const builder = new SceneBuilder("prompt")
      .timeout(5000)
      .turns(3)
      .expect("response", fn);

    const def = builder.toDefinition();
    expect(def.prompt).toBe("prompt");
    expect(def.timeout).toBe(5000);
    expect(def.turns).toBe(3);
    expect(def.assertions).toHaveLength(1);
  });
});

describe("AgentContext", () => {
  describe("registerScene", () => {
    it("returns a SceneBuilder", () => {
      const ctx = new AgentContext(vi.fn());
      const builder = ctx.registerScene("prompt");
      expect(builder).toBeInstanceOf(SceneBuilder);
    });
  });

  describe("execute()", () => {
    it("calls loadConfig", async () => {
      const ctx = new AgentContext(vi.fn());
      ctx.registerScene("p1");
      await ctx.execute();
      expect(mockedLoadConfig).toHaveBeenCalled();
    });

    it("calls executeScene for each registered scene", async () => {
      const executor = vi.fn();
      const ctx = new AgentContext(executor);
      ctx.registerScene("p1");
      ctx.registerScene("p2");
      await ctx.execute();
      expect(mockedExecuteScene).toHaveBeenCalledTimes(2);
    });

    it("computes successRate correctly", async () => {
      mockedExecuteScene
        .mockResolvedValueOnce({ prompt: "p1", response: { text: "r" }, duration: 100, passed: true })
        .mockResolvedValueOnce({ prompt: "p2", response: { text: "r" }, duration: 100, passed: false, error: "fail" });

      const ctx = new AgentContext(vi.fn());
      ctx.registerScene("p1");
      ctx.registerScene("p2");
      const report = await ctx.execute();
      expect(report.successRate).toBe(0.5);
    });

    it("successRate is 0 when no results", async () => {
      const ctx = new AgentContext(vi.fn());
      const report = await ctx.execute();
      expect(report.successRate).toBe(0);
    });

    it("collects failedCases and failedCaseErrors", async () => {
      mockedExecuteScene.mockResolvedValue({
        prompt: "failed-prompt",
        response: { text: "" },
        duration: 100,
        passed: false,
        error: "bad response",
      });

      const ctx = new AgentContext(vi.fn());
      ctx.registerScene("failed-prompt");
      const report = await ctx.execute();
      expect(report.failedCases).toContain("failed-prompt");
      expect(report.failedCaseErrors["failed-prompt"]).toBe("bad response");
    });

    it("computes token averages when metadata has tokens", async () => {
      mockedExecuteScene.mockResolvedValue({
        prompt: "p",
        response: {
          text: "r",
          metadata: { tokens: { input: 100, output: 50 } },
        },
        duration: 100,
        passed: true,
      });

      const ctx = new AgentContext(vi.fn());
      ctx.registerScene("p");
      const report = await ctx.execute();
      expect(report.averageInputTokensPerCase).toBe(100);
      expect(report.averageOutputTokensPerCase).toBe(50);
    });

    it("omits token averages when no token metadata", async () => {
      const ctx = new AgentContext(vi.fn());
      ctx.registerScene("p");
      const report = await ctx.execute();
      expect(report.averageInputTokensPerCase).toBeUndefined();
      expect(report.averageOutputTokensPerCase).toBeUndefined();
    });

    it("extracts model and tools from first result metadata", async () => {
      mockedExecuteScene.mockResolvedValue({
        prompt: "p",
        response: {
          text: "r",
          metadata: { model: "gpt-4", tools: ["search"] },
        },
        duration: 100,
        passed: true,
      });

      const ctx = new AgentContext(vi.fn());
      ctx.registerScene("p");
      const report = await ctx.execute();
      expect(report.model).toBe("gpt-4");
      expect(report.tools).toEqual(["search"]);
    });

    it("calls writeDiffEntry when systemPromptHash is present", async () => {
      mockedExecuteScene.mockResolvedValue({
        prompt: "p",
        response: {
          text: "r",
          metadata: { model: "gpt-4", systemPrompt: "You are helpful" },
        },
        duration: 100,
        passed: true,
      });

      const ctx = new AgentContext(vi.fn());
      ctx.registerScene("p");
      await ctx.execute();
      expect(mockedWriteDiffEntry).toHaveBeenCalled();
    });

    it("appends a checkpoint (standalone) and returns the report", async () => {
      const ctx = new AgentContext(vi.fn(), "test-agent");
      ctx.registerScene("p");
      const report = await ctx.execute();
      expect(mockedAppendCheckpoint).toHaveBeenCalled();
      const checkpoint = mockedAppendCheckpoint.mock.calls[0][0];
      expect(checkpoint.agentName).toBe("test-agent");
      expect(checkpoint.dimensions.suiteHash).toMatch(/^[a-f0-9]{12}$/);
      expect(report.name).toBe("test-agent");
      expect(report.totalCases).toBe(1);
    });

    it("under `agest run`, still appends the checkpoint per-run and writes only a footer line", async () => {
      // Regression: checkpoints used to be buffered by the parent and flushed
      // once after the whole sweep, so interrupting it lost everything. Now the
      // child persists each completed run immediately; the summary file carries
      // just the cross-file footer totals (no checkpoint payload).
      const summaryFile = join(tmpdir(), `agest-summary-${randomUUID()}.jsonl`);
      process.env.AGEST_SUMMARY_FILE = summaryFile;
      try {
        const ctx = new AgentContext(vi.fn(), "run-agent");
        ctx.registerScene("p");
        await ctx.execute();

        expect(mockedAppendCheckpoint).toHaveBeenCalledTimes(1);

        const line = JSON.parse(readFileSync(summaryFile, "utf8").trim());
        expect(line).toMatchObject({ name: "run-agent", total: 1, passed: 1, failed: 0 });
        expect(line.checkpoint).toBeUndefined();
      } finally {
        rmSync(summaryFile, { force: true });
        delete process.env.AGEST_SUMMARY_FILE;
      }
    });

    it("uses config.parallelism", async () => {
      mockedLoadConfig.mockResolvedValue({ parallelism: 5 });
      const ctx = new AgentContext(vi.fn());
      ctx.registerScene("p");
      await ctx.execute();
      // Just verify it doesn't crash with parallelism > 1
      expect(mockedExecuteScene).toHaveBeenCalled();
    });

    it("passes config.timeout, config.judge, config.turns and config.runs to executeScene", async () => {
      mockedLoadConfig.mockResolvedValue({
        timeout: 5000,
        turns: 2,
        runs: 3,
        judge: { model: "judge-model" },
      });

      const ctx = new AgentContext(vi.fn());
      ctx.registerScene("p");
      await ctx.execute();

      expect(mockedExecuteScene).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        5000,
        { model: "judge-model" },
        2,
        3
      );
    });
  });
});
