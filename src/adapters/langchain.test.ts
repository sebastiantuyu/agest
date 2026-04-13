import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@langchain/core/messages", () => ({
  HumanMessage: class HumanMessage {
    content: string;
    constructor(content: string) { this.content = content; }
  },
}));

import { langchain } from "./langchain";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("langchain(runnable) routing", () => {
  it("routes to langGraphAdapter when lg_is_pregel is true", () => {
    const graph = {
      lg_is_pregel: true as const,
      invoke: vi.fn(),
    };
    const executor = langchain(graph);
    expect(typeof executor).toBe("function");
  });

  it("routes to reactAgentAdapter when .options is a non-array object", () => {
    const agent = {
      options: { model: "gpt-4" },
      invoke: vi.fn(),
    };
    const executor = langchain(agent as any);
    expect(typeof executor).toBe("function");
  });

  it("routes to chainAdapter for plain chain (fallthrough)", () => {
    const chain = { invoke: vi.fn() };
    const executor = langchain(chain as any);
    expect(typeof executor).toBe("function");
  });
});

describe("langGraphAdapter", () => {
  const makeGraph = (invokeResult: any, nodes?: any) => ({
    lg_is_pregel: true as const,
    invoke: vi.fn().mockResolvedValue(invokeResult),
    nodes,
  });

  it("extracts text from last message content (string)", async () => {
    const graph = makeGraph({
      messages: [{ content: "hello", response_metadata: {} }],
    });
    const executor = langchain(graph);
    const result = await executor("input");
    expect(result.text).toBe("hello");
  });

  it("JSON.stringifies non-string last message content", async () => {
    const graph = makeGraph({
      messages: [{ content: { parts: ["hi"] }, response_metadata: {} }],
    });
    const executor = langchain(graph);
    const result = await executor("input");
    expect(result.text).toBe('{"parts":["hi"]}');
  });

  it("extracts model from response_metadata.model_name", async () => {
    const graph = makeGraph({
      messages: [{ content: "hi", response_metadata: { model_name: "gpt-4" } }],
    });
    const executor = langchain(graph);
    const result = await executor("input");
    expect(result.metadata?.model).toBe("gpt-4");
  });

  it("extracts tools from graph.nodes.tools.bound.tools", async () => {
    const graph = makeGraph(
      { messages: [{ content: "hi", response_metadata: {} }] },
      { tools: { bound: { tools: [{ name: "search" }, { name: "calc" }] } } }
    );
    const executor = langchain(graph);
    const result = await executor("input");
    expect(result.metadata?.tools).toEqual(["search", "calc"]);
  });

  it("returns executionError when graph.invoke throws", async () => {
    const graph = {
      lg_is_pregel: true as const,
      invoke: vi.fn().mockRejectedValue(new Error("graph error")),
    };
    const executor = langchain(graph);
    const result = await executor("input");
    expect(result.text).toBe("");
    expect(result.executionError).toBe("graph error");
  });

  it("extracts tokens from usage_metadata", async () => {
    const graph = makeGraph({
      messages: [{
        content: "hi",
        response_metadata: {},
        usage_metadata: { input_tokens: 10, output_tokens: 20 },
      }],
    });
    const executor = langchain(graph);
    const result = await executor("input");
    expect(result.metadata?.tokens).toEqual({ input: 10, output: 20 });
  });
});

describe("reactAgentAdapter", () => {
  const makeAgent = (invokeResult: any, options: any = {}) => ({
    options: { model: "gpt-4", tools: [], ...options },
    invoke: vi.fn().mockResolvedValue(invokeResult),
  });

  it("extracts model as string from options.model", async () => {
    const agent = makeAgent(
      { messages: [{ content: "hi" }] },
      { model: "gpt-4" }
    );
    const executor = langchain(agent as any);
    const result = await executor("input");
    expect(result.metadata?.model).toBe("gpt-4");
  });

  it("extracts model from modelName property of model object", async () => {
    const agent = makeAgent(
      { messages: [{ content: "hi" }] },
      { model: { modelName: "gpt-4-turbo" } }
    );
    const executor = langchain(agent as any);
    const result = await executor("input");
    expect(result.metadata?.model).toBe("gpt-4-turbo");
  });

  it("extracts systemPrompt from options.systemPrompt", async () => {
    const agent = makeAgent(
      { messages: [{ content: "hi" }] },
      { model: "m", systemPrompt: "You are helpful" }
    );
    const executor = langchain(agent as any);
    const result = await executor("input");
    expect(result.metadata?.systemPrompt).toBe("You are helpful");
  });

  it("falls back to options.prompt for systemPrompt", async () => {
    const agent = makeAgent(
      { messages: [{ content: "hi" }] },
      { model: "m", prompt: "Be helpful" }
    );
    const executor = langchain(agent as any);
    const result = await executor("input");
    expect(result.metadata?.systemPrompt).toBe("Be helpful");
  });

  it("extracts tool names via .name", async () => {
    const agent = makeAgent(
      { messages: [{ content: "hi" }] },
      { model: "m", tools: [{ name: "search" }, { name: "calc" }] }
    );
    const executor = langchain(agent as any);
    const result = await executor("input");
    expect(result.metadata?.tools).toEqual(["search", "calc"]);
  });

  it("extracts tool names via .getName()", async () => {
    const agent = makeAgent(
      { messages: [{ content: "hi" }] },
      { model: "m", tools: [{ getName: () => "myTool" }] }
    );
    const executor = langchain(agent as any);
    const result = await executor("input");
    expect(result.metadata?.tools).toEqual(["myTool"]);
  });

  it("returns executionError on invoke failure", async () => {
    const agent = {
      options: { model: "m" },
      invoke: vi.fn().mockRejectedValue(new Error("agent error")),
    };
    const executor = langchain(agent as any);
    const result = await executor("input");
    expect(result.executionError).toBe("agent error");
  });
});

describe("chainAdapter", () => {
  const makeChain = (invokeResult: any, steps?: any[]) => ({
    invoke: vi.fn().mockResolvedValue(invokeResult),
    steps,
  });

  it("extracts text from string result", async () => {
    const chain = makeChain("plain string");
    const executor = langchain(chain as any);
    const result = await executor("input");
    expect(result.text).toBe("plain string");
  });

  it("extracts text from result.output", async () => {
    const chain = makeChain({ output: "the output" });
    const executor = langchain(chain as any);
    const result = await executor("input");
    expect(result.text).toBe("the output");
  });

  it("extracts text from result.content", async () => {
    const chain = makeChain({ content: "the content" });
    const executor = langchain(chain as any);
    const result = await executor("input");
    expect(result.text).toBe("the content");
  });

  it("falls back to JSON.stringify for other result shapes", async () => {
    const chain = makeChain({ foo: "bar" });
    const executor = langchain(chain as any);
    const result = await executor("input");
    expect(result.text).toBe('{"foo":"bar"}');
  });

  it("extracts model from chain steps", async () => {
    const chain = makeChain(
      { content: "hi" },
      [{ modelName: "gpt-4" }]
    );
    const executor = langchain(chain as any);
    const result = await executor("input");
    expect(result.metadata?.model).toBe("gpt-4");
  });

  it("extracts systemPrompt from chain steps with promptMessages", async () => {
    const chain = makeChain(
      { content: "hi" },
      [{
        promptMessages: [{
          constructor: { name: "SystemMessagePromptTemplate" },
          prompt: { template: "You are a bot" },
        }],
      }]
    );
    const executor = langchain(chain as any);
    const result = await executor("input");
    expect(result.metadata?.systemPrompt).toBe("You are a bot");
  });

  it("returns executionError on invoke failure", async () => {
    const chain = {
      invoke: vi.fn().mockRejectedValue(new Error("chain error")),
    };
    const executor = langchain(chain as any);
    const result = await executor("input");
    expect(result.executionError).toBe("chain error");
  });

  it("extracts tokens from usage_metadata", async () => {
    const chain = makeChain({
      content: "hi",
      usage_metadata: { input_tokens: 15, output_tokens: 25 },
    });
    const executor = langchain(chain as any);
    const result = await executor("input");
    expect(result.metadata?.tokens).toEqual({ input: 15, output: 25 });
  });

  it("extracts tokens from metadata.tokenUsage (promptTokens format)", async () => {
    const chain = makeChain({
      content: "hi",
      metadata: { tokenUsage: { promptTokens: 10, completionTokens: 20 } },
    });
    const executor = langchain(chain as any);
    const result = await executor("input");
    expect(result.metadata?.tokens).toEqual({ input: 10, output: 20 });
  });

  it("returns undefined tokens when no usage data", async () => {
    const chain = makeChain({ content: "hi" });
    const executor = langchain(chain as any);
    const result = await executor("input");
    expect(result.metadata?.tokens).toBeUndefined();
  });
});
