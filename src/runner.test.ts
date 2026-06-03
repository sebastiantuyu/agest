import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { AgentResponse, SceneDefinition } from "./types.js";
import { extractField, executeScene } from "./runner.js";

vi.mock("./assertions", () => ({
  collectPendingJudgements: vi.fn().mockReturnValue([]),
}));

vi.mock("./judge", () => ({
  resolveJudgeExecutor: vi.fn().mockReturnValue(vi.fn()),
  callJudge: vi.fn(),
}));

import { collectPendingJudgements } from "./assertions.js";
import { resolveJudgeExecutor, callJudge } from "./judge.js";

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

  describe("structured value semantics", () => {
    const structured: AgentResponse<{ plan_items: { options: string[] }[] }> = {
      value: { plan_items: [{ options: ["a", "b"] }] },
      text: "rendered plan",
      metadata: { model: "gpt-4" },
    };

    it("returns the native value for field 'value'", () => {
      expect(extractField(structured, "value")).toEqual({
        plan_items: [{ options: ["a", "b"] }],
      });
    });

    it("returns the native value for field 'response' (alias)", () => {
      expect(extractField(structured, "response")).toEqual(structured.value);
    });

    it("returns the serialized/enriched text view for field 'text'", () => {
      expect(extractField(structured, "text")).toBe("rendered plan");
    });

    it("serializes value for 'text' when no explicit text is given", () => {
      const res: AgentResponse<{ a: number }> = { value: { a: 1 } };
      expect(extractField(res, "text")).toBe('{\n  "a": 1\n}');
    });

    it("navigates a dot-path into the structured value", () => {
      expect(extractField(structured, "plan_items.0.options")).toEqual(["a", "b"]);
      expect(extractField(structured, "plan_items.0.options.1")).toBe("b");
    });

    it("falls back to metadata when the dot-path is absent from value", () => {
      expect(extractField(structured, "model")).toBe("gpt-4");
    });

    it("returns undefined when the path is in neither value nor metadata", () => {
      expect(extractField(structured, "nonexistent")).toBeUndefined();
    });

    it("prefers a value path over a same-named metadata key", () => {
      const res: AgentResponse<{ model: string }> = {
        value: { model: "from-value" },
        metadata: { model: "from-metadata" },
      };
      expect(extractField(res, "model")).toBe("from-value");
    });
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
    it("calls executor with scene prompt and signal", async () => {
      const executor = makeExecutor();
      await executeScene(executor, makeScene());
      expect(executor).toHaveBeenCalledWith("test prompt", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it("carries scene tags through to the single-run result", async () => {
      const result = await executeScene(makeExecutor(), makeScene({ tags: ["refusal", "tool-use"] }));
      expect(result.tags).toEqual(["refusal", "tool-use"]);
    });

    it("carries scene tags through to the multi-run result", async () => {
      const result = await executeScene(
        makeExecutor(),
        makeScene({ tags: ["robustness"], runs: 2 }),
      );
      expect(result.tags).toEqual(["robustness"]);
      expect(result.runs).toHaveLength(2);
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
        (_input: string, opts?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ text: "ok" }), 500);
          opts?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); });
        })
      );
      const result = await executeScene(executor, makeScene({ timeout: 10 }));
      expect(result.passed).toBe(false);
      expect(result.error).toContain("timed out");
    });

    it("falls back to globalTimeout when scene.timeout is undefined", async () => {
      const executor = vi.fn().mockImplementation(
        (_input: string, opts?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ text: "ok" }), 500);
          opts?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); });
        })
      );
      const result = await executeScene(executor, makeScene(), 10);
      expect(result.passed).toBe(false);
      expect(result.error).toContain("timed out");
    });

    it("aborts the signal when timeout fires", async () => {
      let capturedSignal: AbortSignal | undefined;
      const executor = vi.fn().mockImplementation(
        (_input: string, opts?: { signal?: AbortSignal }) => {
          capturedSignal = opts?.signal;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ text: "ok" }), 500);
            opts?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }
      );
      await executeScene(executor, makeScene({ timeout: 10 }));
      expect(capturedSignal?.aborted).toBe(true);
    });

    it("does not abort the signal when executor resolves before timeout", async () => {
      let capturedSignal: AbortSignal | undefined;
      const executor = vi.fn().mockImplementation(
        (_input: string, opts?: { signal?: AbortSignal }) => {
          capturedSignal = opts?.signal;
          return Promise.resolve({ text: "ok" });
        }
      );
      await executeScene(executor, makeScene({ timeout: 200 }));
      expect(capturedSignal?.aborted).toBe(false);
    });
  });

  describe("multi-turn execution", () => {
    it("calls executor N times for N turns", async () => {
      const executor = vi.fn().mockResolvedValue({ text: "response" });
      await executeScene(executor, makeScene({ turns: 3 }));
      expect(executor).toHaveBeenCalledTimes(3);
    });

    it("sends the original prompt on every turn", async () => {
      const executor = vi.fn()
        .mockResolvedValueOnce({ text: "turn1" })
        .mockResolvedValueOnce({ text: "turn2" });
      await executeScene(executor, makeScene({ turns: 2 }));
      expect(executor).toHaveBeenNthCalledWith(1, "test prompt", expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(executor).toHaveBeenNthCalledWith(2, "test prompt", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it("falls back to globalTurns", async () => {
      const executor = vi.fn().mockResolvedValue({ text: "r" });
      await executeScene(executor, makeScene(), undefined, undefined, 2);
      expect(executor).toHaveBeenCalledTimes(2);
    });

    it("falls back to globalRuns when scene.runs is not set", async () => {
      const executor = vi.fn().mockResolvedValue({ text: "ok" });
      const result = await executeScene(executor, makeScene(), undefined, undefined, undefined, 3);
      expect(executor).toHaveBeenCalledTimes(3);
      expect(result.runs).toHaveLength(3);
      expect(result.passRate).toBe(1);
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

  describe("assertion records", () => {
    it("records a passing entry per assertion (no actualValue on green)", async () => {
      const scene = makeScene({
        assertions: [
          { field: "response", fn: () => {} },
          { field: "refusal", fn: () => {} },
        ],
      });
      const result = await executeScene(makeExecutor(), scene);
      expect(result.assertions).toEqual([
        { field: "response", passed: true },
        { field: "refusal", passed: true },
      ]);
    });

    it("records the failing assertion with message + actualValue, and stops", async () => {
      const scene = makeScene({
        assertions: [
          { field: "model", fn: () => { throw new Error("nope"); } },
          { field: "response", fn: () => {} },
        ],
      });
      const result = await executeScene(
        makeExecutor({ text: "ok", metadata: { model: "gpt-4" } }),
        scene,
      );
      expect(result.assertions).toEqual([
        { field: "model", passed: false, message: "nope", actualValue: "gpt-4" },
      ]);
    });

    it("uses a sentinel for the whole value/text fields instead of duplicating them", async () => {
      const scene = makeScene({
        assertions: [{ field: "value", fn: () => { throw new Error("bad shape"); } }],
      });
      const result = await executeScene(makeExecutor({ value: { a: 1 } } as unknown as AgentResponse), scene);
      expect(result.assertions?.[0]).toMatchObject({
        field: "value",
        passed: false,
        actualValue: "<see resolvedValue>",
      });
    });

    it("records a synthetic schema entry on a schema failure", async () => {
      const Plan = z.object({ plan_items: z.array(z.object({ step: z.string() })) });
      const scene = makeScene({ schema: Plan });
      const executor = vi.fn().mockResolvedValue({ value: { plan_items: [{ step: 42 }] } });
      const result = await executeScene(executor, scene);
      const schemaRec = result.assertions?.find((a) => a.field === "schema");
      expect(schemaRec?.passed).toBe(false);
      expect(schemaRec?.message).toContain("plan_items.0.step");
    });

    it("surfaces the failing run's assertions for a multi-run scene", async () => {
      // First two runs fail (model assertion), last passes → minority pass → the
      // scene fails, and the surfaced assertions must be the failing run's, matching `error`.
      let call = 0;
      const executor = vi.fn().mockImplementation(async () => {
        call += 1;
        return { text: "ok", metadata: { model: call <= 2 ? "bad" : "good" } };
      });
      const scene = makeScene({
        runs: 3,
        assertions: [{ field: "model", fn: (v: string) => { if (v === "bad") throw new Error("bad model"); } }],
      });
      const result = await executeScene(executor, scene);
      expect(result.passed).toBe(false); // 1/3 passed → minority
      expect(result.error).toBe("bad model");
      expect(result.assertions).toEqual([
        { field: "model", passed: false, message: "bad model", actualValue: "bad" },
      ]);
    });
  });

  describe("schema validation", () => {
    const Plan = z.object({
      plan_items: z.array(z.object({ step: z.string() })),
    });

    it("passes when the value conforms to scene.schema", async () => {
      const scene = makeScene({ schema: Plan });
      const executor = vi.fn().mockResolvedValue({ value: { plan_items: [{ step: "search" }] } });
      const result = await executeScene(executor, scene);
      expect(result.passed).toBe(true);
    });

    it("fails with a formatted schema error on a mismatch", async () => {
      const scene = makeScene({ schema: Plan });
      const executor = vi.fn().mockResolvedValue({ value: { plan_items: [{ step: 42 }] } });
      const result = await executeScene(executor, scene);
      expect(result.passed).toBe(false);
      expect(result.error).toContain("Schema validation failed");
      expect(result.error).toContain("plan_items.0.step");
    });

    it("skips schema validation for a refusal", async () => {
      const scene = makeScene({ schema: Plan });
      const executor = makeExecutor({ text: "I cannot help with that", refusal: true });
      const result = await executeScene(executor, scene);
      expect(result.passed).toBe(true);
    });

    it("runs schema validation before user assertions", async () => {
      const fn = vi.fn();
      const scene = makeScene({
        schema: Plan,
        assertions: [{ field: "response", fn }],
      });
      const executor = vi.fn().mockResolvedValue({ value: { plan_items: [{ step: 42 }] } });
      const result = await executeScene(executor, scene);
      expect(result.passed).toBe(false);
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("structured value flow (generic T)", () => {
    interface Plan {
      plan_items: { step: string }[];
    }

    it("preserves the native value object on the response (never coerced)", async () => {
      const value: Plan = { plan_items: [{ step: "search" }, { step: "summarize" }] };
      const executor = vi.fn().mockResolvedValue({ value });
      const result = await executeScene<Plan>(executor, makeScene());
      expect(result.passed).toBe(true);
      expect(result.response.value).toBe(value); // same reference, not stringified
    });

    it("feeds extracted structured fields into assertions end-to-end", async () => {
      const value: Plan = { plan_items: [{ step: "search" }, { step: "summarize" }] };
      const seen: unknown[] = [];
      const scene = makeScene({
        assertions: [
          { field: "plan_items", fn: (v) => seen.push(v) },
          { field: "plan_items.0.step", fn: (v) => seen.push(v) },
          { field: "value", fn: (v) => seen.push(v) },
        ],
      });
      const result = await executeScene<Plan>(vi.fn().mockResolvedValue({ value }), scene);
      expect(result.passed).toBe(true);
      expect(seen[0]).toEqual([{ step: "search" }, { step: "summarize" }]);
      expect(seen[1]).toBe("search");
      expect(seen[2]).toBe(value);
    });

    it("fails the scene when a structural assertion on the value throws", async () => {
      const value: Plan = { plan_items: [{ step: "search" }] };
      const scene = makeScene({
        assertions: [
          { field: "plan_items", fn: (v: unknown[]) => {
            if (v.length !== 2) throw new Error("expected 2 items");
          } },
        ],
      });
      const result = await executeScene<Plan>(vi.fn().mockResolvedValue({ value }), scene);
      expect(result.passed).toBe(false);
      expect(result.error).toBe("expected 2 items");
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

    it("hands the judge the serialized text view of a structured value (not [object Object])", async () => {
      mockedCallJudge.mockResolvedValue({ verdict: "pass", reasoning: "ok", criteria: "c" });
      mockedCollect.mockReturnValue([
        { value: { city: "Paris" }, criteria: { criteria: "c", failWhen: "f" } },
      ]);

      await executeScene(makeExecutor(), makeScene(), undefined, { model: "gpt-4" });

      const firstArg = mockedCallJudge.mock.calls[0][0];
      expect(firstArg).toBe('{\n  "city": "Paris"\n}');
      expect(firstArg).not.toContain("[object Object]");
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
