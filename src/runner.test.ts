import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentResponse, SceneDefinition } from "./types";
import { extractField, executeScene } from "./runner";

vi.mock("./assertions", () => ({
  collectPendingJudgements: vi.fn().mockReturnValue([]),
}));

vi.mock("./judge", () => ({
  resolveJudgeExecutor: vi.fn().mockReturnValue(vi.fn()),
  callJudge: vi.fn(),
}));

import { collectPendingJudgements } from "./assertions";
import { resolveJudgeExecutor, callJudge } from "./judge";

const mockedCollect = vi.mocked(collectPendingJudgements);
const mockedResolveJudge = vi.mocked(resolveJudgeExecutor);
const mockedCallJudge = vi.mocked(callJudge);

beforeEach(() => {
  vi.clearAllMocks();
  mockedCollect.mockReturnValue([]);
});

describe("extractField", () => {
  const response: AgentResponse = {
    text: "hello",
    refusal: false,
    metadata: { model: "gpt-4", tokens: { input: 10, output: 20 } },
  };

  it("returns response.text for field 'response'", () => {
    expect(extractField(response, "response")).toBe("hello");
  });

  it("returns response.metadata for field 'metadata'", () => {
    expect(extractField(response, "metadata")).toBe(response.metadata);
  });

  it("returns response.refusal for field 'refusal'", () => {
    expect(extractField(response, "refusal")).toBe(false);
  });

  it("returns metadata[field] for any other field", () => {
    expect(extractField(response, "model")).toBe("gpt-4");
  });

  it("returns undefined when metadata is undefined and field is arbitrary", () => {
    expect(extractField({ text: "" }, "model")).toBeUndefined();
  });
});

describe("executeScene", () => {
  const makeScene = (overrides: Partial<SceneDefinition> = {}): SceneDefinition => ({
    prompt: "test prompt",
    assertions: [],
    ...overrides,
  });

  const makeExecutor = (response: AgentResponse = { text: "ok" }) =>
    vi.fn().mockResolvedValue(response);

  describe("basic execution", () => {
    it("calls executor with scene prompt", async () => {
      const executor = makeExecutor();
      await executeScene(executor, makeScene());
      expect(executor).toHaveBeenCalledWith("test prompt");
    });

    it("returns SceneResult with passed: true when no assertions", async () => {
      const result = await executeScene(makeExecutor(), makeScene());
      expect(result.passed).toBe(true);
      expect(result.prompt).toBe("test prompt");
      expect(result.response.text).toBe("ok");
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe("timeout behavior", () => {
    it("uses scene.timeout when provided", async () => {
      const executor = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ text: "ok" }), 50))
      );
      const result = await executeScene(executor, makeScene({ timeout: 200 }));
      expect(result.passed).toBe(true);
    });

    it("returns passed: false when executor exceeds timeout", async () => {
      const executor = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ text: "ok" }), 500))
      );
      const result = await executeScene(executor, makeScene({ timeout: 10 }));
      expect(result.passed).toBe(false);
      expect(result.error).toContain("timed out");
    });

    it("falls back to globalTimeout when scene.timeout is undefined", async () => {
      const executor = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ text: "ok" }), 500))
      );
      const result = await executeScene(executor, makeScene(), 10);
      expect(result.passed).toBe(false);
      expect(result.error).toContain("timed out");
    });
  });

  describe("multi-turn execution", () => {
    it("calls executor N times for N turns", async () => {
      const executor = vi.fn().mockResolvedValue({ text: "response" });
      await executeScene(executor, makeScene({ turns: 3 }));
      expect(executor).toHaveBeenCalledTimes(3);
    });

    it("feeds response.text as input to subsequent turns", async () => {
      const executor = vi.fn()
        .mockResolvedValueOnce({ text: "turn1" })
        .mockResolvedValueOnce({ text: "turn2" });
      await executeScene(executor, makeScene({ turns: 2 }));
      expect(executor).toHaveBeenNthCalledWith(1, "test prompt");
      expect(executor).toHaveBeenNthCalledWith(2, "turn1");
    });

    it("falls back to globalTurns", async () => {
      const executor = vi.fn().mockResolvedValue({ text: "r" });
      await executeScene(executor, makeScene(), undefined, undefined, 2);
      expect(executor).toHaveBeenCalledTimes(2);
    });

    it("stops early if response.executionError is set mid-turn", async () => {
      const executor = vi.fn()
        .mockResolvedValueOnce({ text: "ok" })
        .mockResolvedValueOnce({ text: "", executionError: "boom" });
      const result = await executeScene(executor, makeScene({ turns: 3 }));
      expect(executor).toHaveBeenCalledTimes(2);
      expect(result.passed).toBe(false);
    });
  });

  describe("executionError handling", () => {
    it("returns passed: false when response.executionError is set", async () => {
      const executor = makeExecutor({ text: "", executionError: "failed" });
      const result = await executeScene(executor, makeScene());
      expect(result.passed).toBe(false);
      expect(result.error).toBe("failed");
    });
  });

  describe("executor throw", () => {
    it("catches executor rejection and returns passed: false, duration: 0", async () => {
      const executor = vi.fn().mockRejectedValue(new Error("Network error"));
      const result = await executeScene(executor, makeScene());
      expect(result.passed).toBe(false);
      expect(result.duration).toBe(0);
      expect(result.error).toBe("Network error");
    });
  });

  describe("assertions", () => {
    it("calls assertion.fn with extracted field value", async () => {
      const fn = vi.fn();
      const scene = makeScene({
        assertions: [{ field: "response", fn }],
      });
      await executeScene(makeExecutor({ text: "hello" }), scene);
      expect(fn).toHaveBeenCalledWith("hello");
    });

    it("returns passed: true when all assertions pass", async () => {
      const scene = makeScene({
        assertions: [{ field: "response", fn: () => {} }],
      });
      const result = await executeScene(makeExecutor(), scene);
      expect(result.passed).toBe(true);
    });

    it("returns passed: false when an assertion throws", async () => {
      const scene = makeScene({
        assertions: [
          { field: "response", fn: () => { throw new Error("bad"); } },
        ],
      });
      const result = await executeScene(makeExecutor(), scene);
      expect(result.passed).toBe(false);
      expect(result.error).toBe("bad");
    });

    it("stops on first failing assertion", async () => {
      const fn2 = vi.fn();
      const scene = makeScene({
        assertions: [
          { field: "response", fn: () => { throw new Error("first"); } },
          { field: "response", fn: fn2 },
        ],
      });
      await executeScene(makeExecutor(), scene);
      expect(fn2).not.toHaveBeenCalled();
    });
  });

  describe("judge integration", () => {
    it("skips judge when pending is empty", async () => {
      mockedCollect.mockReturnValue([]);
      await executeScene(makeExecutor(), makeScene(), undefined, { model: "gpt-4" });
      expect(mockedCallJudge).not.toHaveBeenCalled();
    });

    it("skips judge when assertions already failed", async () => {
      mockedCollect.mockReturnValue([
        { value: "resp", criteria: { criteria: "c", failWhen: "f" } },
      ]);
      const scene = makeScene({
        assertions: [{ field: "response", fn: () => { throw new Error("fail"); } }],
      });
      await executeScene(makeExecutor(), scene, undefined, { model: "gpt-4" });
      expect(mockedCallJudge).not.toHaveBeenCalled();
    });

    it("returns error when judgeConfig is undefined", async () => {
      mockedCollect.mockReturnValue([
        { value: "resp", criteria: { criteria: "c", failWhen: "f" } },
      ]);
      const result = await executeScene(makeExecutor(), makeScene());
      expect(result.passed).toBe(false);
      expect(result.error).toContain("requires a judge configured");
    });

    it("calls callJudge for pending judgements", async () => {
      const judgeResult = { verdict: "pass" as const, reasoning: "ok", criteria: "c" };
      mockedCallJudge.mockResolvedValue(judgeResult);
      mockedCollect.mockReturnValue([
        { value: "resp", criteria: { criteria: "c", failWhen: "f" } },
      ]);

      const result = await executeScene(makeExecutor(), makeScene(), undefined, { model: "gpt-4" });
      expect(mockedCallJudge).toHaveBeenCalled();
      expect(result.passed).toBe(true);
      expect(result.judgement).toEqual(judgeResult);
    });

    it("sets passed: false when judge verdict is fail", async () => {
      mockedCallJudge.mockResolvedValue({
        verdict: "fail",
        reasoning: "Bad",
        criteria: "c",
      });
      mockedCollect.mockReturnValue([
        { value: "resp", criteria: { criteria: "c", failWhen: "f" } },
      ]);

      const result = await executeScene(makeExecutor(), makeScene(), undefined, { model: "gpt-4" });
      expect(result.passed).toBe(false);
      expect(result.error).toContain("fail");
    });

    it("sets passed: false when judge verdict is partial", async () => {
      mockedCallJudge.mockResolvedValue({
        verdict: "partial",
        reasoning: "Meh",
        criteria: "c",
      });
      mockedCollect.mockReturnValue([
        { value: "resp", criteria: { criteria: "c", failWhen: "f" } },
      ]);

      const result = await executeScene(makeExecutor(), makeScene(), undefined, { model: "gpt-4" });
      expect(result.passed).toBe(false);
    });

    it("handles callJudge throwing", async () => {
      mockedCallJudge.mockRejectedValue(new Error("judge broke"));
      mockedCollect.mockReturnValue([
        { value: "resp", criteria: { criteria: "c", failWhen: "f" } },
      ]);

      const result = await executeScene(makeExecutor(), makeScene(), undefined, { model: "gpt-4" });
      expect(result.passed).toBe(false);
      expect(result.error).toContain("Judge error: judge broke");
    });
  });
});
