import { describe, it, expect, vi } from "vitest";
import type { AgentExecutor, AgentResponse } from "./types.js";
import { createTrace } from "./adapters/tracing.js";
import { executeScene } from "./runner.js";
import { formatReport } from "./reporter.js";

/**
 * Regression coverage for the vitalitas-style integration: a CUSTOM executor
 * (not the `langchain()` adapter) that runs its own LangChain/LangGraph
 * pipeline and uses `createTrace()` to surface the cost/timeline waterfall.
 *
 * Mirrors `packages/agents/src/agest/_lib/make-executor.ts`: resolve a
 * scenario, run a graph forwarding `trace.callbacks`, then spread
 * `trace.collect()` into the response metadata.
 */

/**
 * Fake LangGraph-ish pipeline. Its `invoke` drives the provided callbacks the
 * way a real multi-step agent would: one model call, a tool call, then a final
 * model call — proving callbacks propagate through `createTrace`.
 */
function fakeGeneratePlan() {
  return {
    invoke: vi.fn(async (_input: unknown, config?: { callbacks?: any[] }) => {
      const h = config?.callbacks?.[0];
      if (h) {
        h.handleChatModelStart(
          { id: ["chat", "ChatOpenAI"] }, [], "llm-1", undefined,
          { invocation_params: { model: "gpt-4o" } },
        );
        h.handleLLMEnd(
          { generations: [[{ message: { usage_metadata: { input_tokens: 800, output_tokens: 60 } } }]] },
          "llm-1",
        );
        h.handleToolStart({ name: "search_recipes" }, "query", "tool-1");
        h.handleToolEnd("result", "tool-1");
        h.handleChatModelStart(
          { id: ["chat", "ChatOpenAI"] }, [], "llm-2", undefined,
          { invocation_params: { model: "gpt-4o" } },
        );
        h.handleLLMEnd(
          { generations: [[{ message: { usage_metadata: { input_tokens: 300, output_tokens: 40 } } }]] },
          "llm-2",
        );
      }
      return { plan: "rendered plan text" };
    }),
  };
}

function makeTracedExecutor(graph: ReturnType<typeof fakeGeneratePlan>): AgentExecutor {
  return async (_scenarioId: string): Promise<AgentResponse> => {
    const trace = await createTrace({ model: "gpt-4o" });
    const result = await graph.invoke({ input: "fixture" }, { callbacks: trace.callbacks });
    return {
      text: String((result as any).plan),
      metadata: {
        model: "gpt-4o",
        tools: ["search_recipes", "search_foods"],
        systemPrompt: "vitalitas-plan-generator-v1",
        ...trace.collect(),
      },
    };
  };
}

describe("custom executor + createTrace (vitalitas-style)", () => {
  it("captures tokens/cost/timeline through executeScene", async () => {
    const graph = fakeGeneratePlan();
    const executor = makeTracedExecutor(graph);

    const result = await executeScene(executor, {
      prompt: "maria-cena-only",
      assertions: [],
    });

    expect(result.passed).toBe(true);
    // graph received the propagating callbacks
    expect(graph.invoke).toHaveBeenCalledWith(
      { input: "fixture" },
      expect.objectContaining({ callbacks: expect.any(Array) }),
    );

    // aggregated across both model calls (tool call excluded)
    expect(result.tokens).toEqual({ input: 1100, output: 100 });
    expect(result.costUsd).toBeCloseTo((1100 / 1e6) * 2.5 + (100 / 1e6) * 10);
    expect(result.costSource).toBe("table");

    // full waterfall, ordered, with the tool call between the two model calls
    expect(result.events?.map((e) => e.kind)).toEqual(["model", "tool", "model"]);
    expect(result.events?.[1].name).toBe("search_recipes");
  });

  it("renders the timeline + totals in the YAML report", async () => {
    const executor = makeTracedExecutor(fakeGeneratePlan());
    const result = await executeScene(executor, { prompt: "maria-cena-only", assertions: [] });

    const yaml = formatReport({
      name: "trace-coverage",
      successRate: 1,
      failedCases: [],
      failedCaseErrors: {},
      timestamp: "2026-05-29T00:00:00.000Z",
      duration: Math.round(result.duration),
      totalCases: 1,
      totalInputTokens: result.tokens?.input,
      totalOutputTokens: result.tokens?.output,
      totalCostUsd: result.costUsd,
      results: [result],
    });

    expect(yaml).toContain("scenes:");
    expect(yaml).toContain("timeline:");
    expect(yaml).toContain("kind: tool");
    expect(yaml).toContain('name: "search_recipes"');
    expect(yaml).toContain("cost_usd:");
    expect(yaml).toContain("total_cost_usd:");
  });
});
