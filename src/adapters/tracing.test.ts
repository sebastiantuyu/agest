import { describe, it, expect, vi } from "vitest";

vi.mock("@langchain/core/messages", () => ({
  HumanMessage: class HumanMessage {
    content: string;
    constructor(content: string) { this.content = content; }
  },
}));

import { langchain } from "./langchain";

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
