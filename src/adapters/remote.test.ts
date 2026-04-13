import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { remote } from "./remote";

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Bad Request",
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    statusText: "OK",
    headers: { "Content-Type": "text/plain" },
  });
}

describe("remote adapter — request building", () => {
  it("sends POST with { prompt } by default", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ text: "hi" }));
    const executor = remote("http://example.com/api");

    await executor("hello");

    expect(mockFetch).toHaveBeenCalledWith("http://example.com/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
  });

  it("merges custom headers", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ text: "hi" }));
    const executor = remote("http://example.com/api", {
      headers: { Authorization: "Bearer sk-123" },
    });

    await executor("hello");

    const call = mockFetch.mock.calls[0];
    expect(call[1].headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-123",
    });
  });

  it("uses custom buildRequest", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ text: "hi" }));
    const executor = remote("http://example.com/api", {
      buildRequest: (input) => ({ messages: [{ role: "user", content: input }] }),
    });

    await executor("hello");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ messages: [{ role: "user", content: "hello" }] });
  });

  it("omits body for GET requests", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ text: "hi" }));
    const executor = remote("http://example.com/api", { method: "GET" });

    await executor("hello");

    expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
  });
});

describe("remote adapter — text extraction", () => {
  it("extracts text from { text }", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ text: "answer" }));
    const result = await remote("http://x.com")(("q"));
    expect(result.text).toBe("answer");
  });

  it("extracts text from { response }", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ response: "answer" }));
    const result = await remote("http://x.com")("q");
    expect(result.text).toBe("answer");
  });

  it("extracts text from { output }", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ output: "answer" }));
    const result = await remote("http://x.com")("q");
    expect(result.text).toBe("answer");
  });

  it("extracts text from { message }", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ message: "answer" }));
    const result = await remote("http://x.com")("q");
    expect(result.text).toBe("answer");
  });

  it("extracts text from { content }", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ content: "answer" }));
    const result = await remote("http://x.com")("q");
    expect(result.text).toBe("answer");
  });

  it("extracts text from { answer }", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ answer: "answer" }));
    const result = await remote("http://x.com")("q");
    expect(result.text).toBe("answer");
  });

  it("extracts text from nested { data: { text } }", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: { text: "nested" } }));
    const result = await remote("http://x.com")("q");
    expect(result.text).toBe("nested");
  });

  it("extracts text from nested { result: { output } }", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ result: { output: "nested" } }));
    const result = await remote("http://x.com")("q");
    expect(result.text).toBe("nested");
  });

  it("falls back to JSON.stringify for unknown shapes", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ foo: "bar" }));
    const result = await remote("http://x.com")("q");
    expect(result.text).toBe('{"foo":"bar"}');
  });

  it("handles plain text responses", async () => {
    mockFetch.mockResolvedValue(textResponse("plain answer"));
    const result = await remote("http://x.com")("q");
    expect(result.text).toBe("plain answer");
  });
});

describe("remote adapter — metadata", () => {
  it("passes static metadata through", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ text: "hi" }));
    const executor = remote("http://x.com", {
      metadata: { model: "gpt-4o", tools: ["search"], systemPrompt: "be helpful" },
    });

    const result = await executor("q");

    expect(result.metadata?.model).toBe("gpt-4o");
    expect(result.metadata?.tools).toEqual(["search"]);
    expect(result.metadata?.systemPrompt).toBe("be helpful");
  });

  it("extracts model from response body", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ text: "hi", model: "claude-3" }));
    const result = await remote("http://x.com")("q");
    expect(result.metadata?.model).toBe("claude-3");
  });

  it("extracts tokens from { usage: { input_tokens, output_tokens } }", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ text: "hi", usage: { input_tokens: 10, output_tokens: 20 } }),
    );
    const result = await remote("http://x.com")("q");
    expect(result.metadata?.tokens).toEqual({ input: 10, output: 20 });
  });

  it("extracts tokens from { usage: { prompt_tokens, completion_tokens } }", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ text: "hi", usage: { prompt_tokens: 5, completion_tokens: 15 } }),
    );
    const result = await remote("http://x.com")("q");
    expect(result.metadata?.tokens).toEqual({ input: 5, output: 15 });
  });

  it("extracts tokens from { tokens: { promptTokens, completionTokens } }", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ text: "hi", tokens: { promptTokens: 8, completionTokens: 12 } }),
    );
    const result = await remote("http://x.com")("q");
    expect(result.metadata?.tokens).toEqual({ input: 8, output: 12 });
  });

  it("static metadata merges with response metadata", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ text: "hi", model: "remote-model", usage: { input_tokens: 1, output_tokens: 2 } }),
    );
    const executor = remote("http://x.com", {
      metadata: { tools: ["calc"], systemPrompt: "do math" },
    });

    const result = await executor("q");

    expect(result.metadata?.tools).toEqual(["calc"]);
    expect(result.metadata?.systemPrompt).toBe("do math");
    expect(result.metadata?.model).toBe("remote-model");
    expect(result.metadata?.tokens).toEqual({ input: 1, output: 2 });
  });
});

describe("remote adapter — parseResponse override", () => {
  it("uses custom parseResponse when provided", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "parsed" } }], usage: { prompt_tokens: 3, completion_tokens: 7 } }),
    );
    const executor = remote("http://x.com", {
      parseResponse: (body: any) => ({
        text: body.choices[0].message.content,
        metadata: {
          tokens: { input: body.usage.prompt_tokens, output: body.usage.completion_tokens },
        },
      }),
    });

    const result = await executor("q");

    expect(result.text).toBe("parsed");
    expect(result.metadata?.tokens).toEqual({ input: 3, output: 7 });
  });

  it("merges static metadata on top of parseResponse metadata", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ text: "hi" }));
    const executor = remote("http://x.com", {
      parseResponse: () => ({ text: "custom", metadata: { model: "from-response" } }),
      metadata: { tools: ["search"] },
    });

    const result = await executor("q");

    expect(result.text).toBe("custom");
    expect(result.metadata?.tools).toEqual(["search"]);
    expect(result.metadata?.model).toBe("from-response");
  });
});

describe("remote adapter — error handling", () => {
  it("returns executionError on network failure", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const executor = remote("http://x.com", {
      metadata: { model: "test" },
    });

    const result = await executor("q");

    expect(result.text).toBe("");
    expect(result.executionError).toBe("Request failed: ECONNREFUSED");
    expect(result.metadata?.model).toBe("test");
  });

  it("returns executionError on non-ok HTTP status", async () => {
    mockFetch.mockResolvedValue(
      new Response("", { status: 500, statusText: "Internal Server Error" }),
    );
    const executor = remote("http://x.com");

    const result = await executor("q");

    expect(result.text).toBe("");
    expect(result.executionError).toBe("HTTP 500: Internal Server Error");
  });

  it("preserves static metadata on HTTP error", async () => {
    mockFetch.mockResolvedValue(
      new Response("", { status: 401, statusText: "Unauthorized" }),
    );
    const executor = remote("http://x.com", {
      metadata: { model: "gpt-4o" },
    });

    const result = await executor("q");

    expect(result.executionError).toBe("HTTP 401: Unauthorized");
    expect(result.metadata?.model).toBe("gpt-4o");
  });
});
