import { describe, it, expect, vi } from "vitest";

vi.mock("@langchain/core/messages", () => ({
  HumanMessage: class HumanMessage {
    content: string;
    constructor(content: string) { this.content = content; }
  },
}));

import { langchain } from "./langchain";
import { createTrace, summarizeEvents } from "./tracing";
import type { TimelineEvent } from "../types";

/**
 * Build a fake LangGraph runnable whose `invoke` calls each callback in
 * `scenario` against any handlers passed via `options.callbacks`. This lets
 * us verify the tracing wiring end-to-end without needing the real
 * @langchain/core runtime.
 */
function fakeGraph(scenario: (handler: any) => Promise<void>, lastMessage: any) {
  return {
    lg_is_pregel: true as const,
    invoke: vi.fn(async (_input: any, options?: { callbacks?: any[] }) => {
      const handler = options?.callbacks?.[0];
      if (handler) await scenario(handler);
      return { messages: [lastMessage] };
    }),
  };
}

describe("langchain adapter tracing", () => {
  it("captures a single model invocation with tokens and computed cost", async () => {
    const graph = fakeGraph(async (h) => {
      h.handleChatModelStart(
        { id: ["langchain", "chat_models", "openai", "ChatOpenAI"] },
        [],
        "run-1",
        undefined,
        { invocation_params: { model: "gpt-4o" } },
      );
      await new Promise((r) => setTimeout(r, 5));
      h.handleLLMEnd(
        {
          generations: [[
            { message: { usage_metadata: { input_tokens: 1000, output_tokens: 500 } } },
          ]],
        },
        "run-1",
      );
    }, { content: "done", response_metadata: { model_name: "gpt-4o" } });

    const executor = langchain(graph as any);
    const result = await executor("hello");

    expect(result.metadata?.events).toHaveLength(1);
    const event = result.metadata!.events![0];
    expect(event.kind).toBe("model");
    expect(event.name).toBe("gpt-4o");
    expect(event.tokens).toEqual({ input: 1000, output: 500 });
    expect(event.cost?.source).toBe("table");
    expect(event.cost?.totalUsd).toBeCloseTo((1000 / 1e6) * 2.5 + (500 / 1e6) * 10);

    // Aggregate on the response metadata
    expect(result.metadata?.tokens).toEqual({ input: 1000, output: 500 });
    expect(result.metadata?.cost?.totalUsd).toBeGreaterThan(0);
  });

  it("captures interleaved tool calls in start-order", async () => {
    const graph = fakeGraph(async (h) => {
      h.handleChatModelStart(
        { id: ["chat", "ChatOpenAI"] }, [], "llm-1", undefined,
        { invocation_params: { model: "gpt-4o-mini" } },
      );
      await new Promise((r) => setTimeout(r, 2));
      h.handleLLMEnd(
        { generations: [[{ message: { usage_metadata: { input_tokens: 10, output_tokens: 5 } } }]] },
        "llm-1",
      );

      h.handleToolStart({ name: "dictionary_lookup" }, "word", "tool-1");
      await new Promise((r) => setTimeout(r, 2));
      h.handleToolEnd("result", "tool-1");

      h.handleChatModelStart(
        { id: ["chat", "ChatOpenAI"] }, [], "llm-2", undefined,
        { invocation_params: { model: "gpt-4o-mini" } },
      );
      await new Promise((r) => setTimeout(r, 2));
      h.handleLLMEnd(
        { generations: [[{ message: { usage_metadata: { input_tokens: 30, output_tokens: 8 } } }]] },
        "llm-2",
      );
    }, { content: "ok", response_metadata: {} });

    const executor = langchain(graph as any);
    const result = await executor("ask");

    const events = result.metadata?.events ?? [];
    expect(events.map((e) => e.kind)).toEqual(["model", "tool", "model"]);
    expect(events[1].name).toBe("dictionary_lookup");
    // Aggregate tokens sum both model events
    expect(result.metadata?.tokens).toEqual({ input: 40, output: 13 });
    // start_ms must be monotonically non-decreasing
    for (let i = 1; i < events.length; i++) {
      expect(events[i].startMs).toBeGreaterThanOrEqual(events[i - 1].startMs);
    }
  });

  it("propagates provider cost when present in usage", async () => {
    const graph = fakeGraph(async (h) => {
      h.handleChatModelStart(
        { id: ["chat", "ChatOpenAI"] }, [], "run-x", undefined,
        { invocation_params: { model: "openai/gpt-4o" } },
      );
      h.handleLLMEnd(
        {
          llmOutput: { usage: { cost: 0.0123 } },
          generations: [[
            { message: { usage_metadata: { input_tokens: 100, output_tokens: 50 } } },
          ]],
        },
        "run-x",
      );
    }, { content: "ok", response_metadata: {} });

    const executor = langchain(graph as any);
    const result = await executor("ask");
    expect(result.metadata?.cost?.source).toBe("provider");
    expect(result.metadata?.cost?.totalUsd).toBeCloseTo(0.0123);
  });

  it("records errored model invocations", async () => {
    const graph = fakeGraph(async (h) => {
      h.handleChatModelStart(
        { id: ["chat", "ChatOpenAI"] }, [], "run-e", undefined,
        { invocation_params: { model: "gpt-4o" } },
      );
      h.handleLLMError(new Error("rate limited"), "run-e");
    }, { content: "ok", response_metadata: {} });

    const executor = langchain(graph as any);
    const result = await executor("ask");
    const events = result.metadata?.events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0].error).toBe("rate limited");
  });
});

describe("summarizeEvents", () => {
  const modelEvent = (over: Partial<TimelineEvent>): TimelineEvent => ({
    kind: "model",
    name: "gpt-4o",
    startMs: 0,
    endMs: 1,
    durationMs: 1,
    ...over,
  });

  it("sums tokens across model events and computes table cost", () => {
    const { tokens, cost } = summarizeEvents(
      [
        modelEvent({ tokens: { input: 100, output: 50 } }),
        modelEvent({ tokens: { input: 200, output: 25 } }),
      ],
      "gpt-4o",
    );
    expect(tokens).toEqual({ input: 300, output: 75 });
    expect(cost?.source).toBe("table");
    expect(cost?.totalUsd).toBeCloseTo((300 / 1e6) * 2.5 + (75 / 1e6) * 10);
  });

  it("prefers provider cost over the table", () => {
    const { cost } = summarizeEvents(
      [modelEvent({ tokens: { input: 100, output: 50 }, cost: { totalUsd: 0.01, source: "provider" } })],
      "gpt-4o",
    );
    expect(cost).toEqual({ totalUsd: 0.01, source: "provider" });
  });

  it("ignores tool events and falls back to fallbackTokens when no usage", () => {
    const { tokens } = summarizeEvents(
      [{ kind: "tool", name: "search", startMs: 0, endMs: 5, durationMs: 5 }],
      "gpt-4o",
      { input: 9, output: 3 },
    );
    expect(tokens).toEqual({ input: 9, output: 3 });
  });
});

describe("tool naming", () => {
  it("prefers the runName over the serialized tool class name", async () => {
    const trace = await createTrace();
    const h = trace.callbacks[0];
    // LangChain serializes the tool by class (DynamicStructuredTool) and passes
    // the real tool name as `runName` (7th arg).
    h.handleToolStart(
      { id: ["langchain", "tools", "DynamicStructuredTool"], name: "DynamicStructuredTool" },
      "query",
      "tool-1",
      undefined,
      undefined,
      undefined,
      "search_recipes",
    );
    h.handleToolEnd("ok", "tool-1");
    const { events } = trace.collect();
    expect(events[0].name).toBe("search_recipes");
  });
});

describe("OpenRouter usage accounting", () => {
  it("uses provider cost from response_metadata.usage and captures cached tokens", async () => {
    const trace = await createTrace({ model: "openai/gpt-5.4" });
    const h = trace.callbacks[0];
    h.handleChatModelStart(
      { id: ["chat", "ChatOpenAI"] }, [], "r1", undefined,
      { invocation_params: { model: "openai/gpt-5.4" } },
    );
    h.handleLLMEnd(
      {
        generations: [[{
          message: {
            usage_metadata: {
              input_tokens: 5299,
              output_tokens: 245,
              input_token_details: { cache_read: 4800 },
            },
            response_metadata: { usage: { cost: 0.0021, prompt_tokens_details: { cached_tokens: 4800 } } },
          },
        }]],
      },
      "r1",
    );
    const { events, cost } = trace.collect();
    // provider cost wins over the (much higher) table estimate
    expect(cost?.source).toBe("provider");
    expect(cost?.totalUsd).toBeCloseTo(0.0021);
    expect(events[0].cachedInputTokens).toBe(4800);
  });
});

describe("createTrace", () => {
  it("collects events, tokens, and cost from a traced run; memoizes collect()", async () => {
    const trace = await createTrace({ model: "gpt-4o" });
    const h = trace.callbacks[0];
    expect(typeof h?.handleChatModelStart).toBe("function");

    h.handleChatModelStart(
      { id: ["chat", "ChatOpenAI"] }, [], "r1", undefined,
      { invocation_params: { model: "gpt-4o" } },
    );
    h.handleLLMEnd(
      { generations: [[{ message: { usage_metadata: { input_tokens: 120, output_tokens: 30 } } }]] },
      "r1",
    );

    const out = trace.collect();
    expect(out.events).toHaveLength(1);
    expect(out.tokens).toEqual({ input: 120, output: 30 });
    expect(out.cost?.source).toBe("table");

    // memoized — second call returns the same object even though drain() cleared
    expect(trace.collect()).toBe(out);
  });
});
