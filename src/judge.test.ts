import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveJudgeExecutor, callJudge } from "./judge";
import type { JudgeConfig, JudgeExecutor } from "./config";

describe("resolveJudgeExecutor", () => {
  it("returns config.executor when provided", () => {
    const executor: JudgeExecutor = vi.fn();
    const config: JudgeConfig = { executor };
    expect(resolveJudgeExecutor(config)).toBe(executor);
  });

  it("returns a fetch-based executor when no custom executor", () => {
    const config: JudgeConfig = { model: "gpt-4" };
    const result = resolveJudgeExecutor(config);
    expect(typeof result).toBe("function");
  });
});

describe("buildFetchExecutor (via resolveJudgeExecutor)", () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("calls fetch with correct URL and body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "result" } }] }),
    });

    const executor = resolveJudgeExecutor({
      model: "test-model",
      apiKey: "test-key",
      baseUrl: "http://localhost:8080",
    });

    await executor("hello");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:8080/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(body.temperature).toBe(0);
  });

  it("uses default base URL and model when not provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });

    const executor = resolveJudgeExecutor({ apiKey: "k" });
    await executor("test");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.anything()
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe("openai/gpt-oss-20b");
  });

  it("falls back to OPENROUTER_API_KEY env var", async () => {
    process.env.OPENROUTER_API_KEY = "env-key";
    delete process.env.OPENAI_API_KEY;

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });

    const executor = resolveJudgeExecutor({});
    await executor("test");

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer env-key");
  });

  it("falls back to OPENAI_API_KEY env var", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.OPENAI_API_KEY = "openai-key";

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });

    const executor = resolveJudgeExecutor({});
    await executor("test");

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer openai-key");
  });

  it("returns content string from response", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "the answer" } }] }),
    });

    const executor = resolveJudgeExecutor({ apiKey: "k" });
    const result = await executor("test");
    expect(result).toBe("the answer");
  });

  it("returns empty string when no content", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [] }),
    });

    const executor = resolveJudgeExecutor({ apiKey: "k" });
    const result = await executor("test");
    expect(result).toBe("");
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const executor = resolveJudgeExecutor({ apiKey: "k" });
    await expect(executor("test")).rejects.toThrow("Judge API error 500");
  });
});

describe("callJudge", () => {
  const criteria = { criteria: "Is it helpful?", failWhen: "Not helpful" };

  it("returns pass verdict", async () => {
    const executor = vi.fn().mockResolvedValue(
      '{"verdict": "pass", "reasoning": "Looks good"}'
    );

    const result = await callJudge("Some response", criteria, executor);
    expect(result.verdict).toBe("pass");
    expect(result.reasoning).toBe("Looks good");
    expect(result.criteria).toBe("Is it helpful?");
  });

  it("returns fail verdict", async () => {
    const executor = vi.fn().mockResolvedValue(
      '{"verdict": "fail", "reasoning": "Bad"}'
    );

    const result = await callJudge("response", criteria, executor);
    expect(result.verdict).toBe("fail");
  });

  it("returns partial verdict", async () => {
    const executor = vi.fn().mockResolvedValue(
      '{"verdict": "partial", "reasoning": "Okay"}'
    );

    const result = await callJudge("response", criteria, executor);
    expect(result.verdict).toBe("partial");
  });

  it("prompt includes criteria sections", async () => {
    const executor = vi.fn().mockResolvedValue(
      '{"verdict": "pass", "reasoning": "ok"}'
    );

    await callJudge("response text", criteria, executor);
    const prompt = executor.mock.calls[0][0] as string;
    expect(prompt).toContain("response text");
    expect(prompt).toContain("Is it helpful?");
    expect(prompt).toContain("Not helpful");
  });

  it("includes context section when provided", async () => {
    const executor = vi.fn().mockResolvedValue(
      '{"verdict": "pass", "reasoning": "ok"}'
    );

    await callJudge("resp", { ...criteria, context: "Extra info" }, executor);
    const prompt = executor.mock.calls[0][0] as string;
    expect(prompt).toContain("Additional Context");
    expect(prompt).toContain("Extra info");
  });

  it("omits context section when undefined", async () => {
    const executor = vi.fn().mockResolvedValue(
      '{"verdict": "pass", "reasoning": "ok"}'
    );

    await callJudge("resp", criteria, executor);
    const prompt = executor.mock.calls[0][0] as string;
    expect(prompt).not.toContain("Additional Context");
  });

  it("throws when executor returns no JSON", async () => {
    const executor = vi.fn().mockResolvedValue("no json here");

    await expect(callJudge("resp", criteria, executor)).rejects.toThrow(
      "Judge returned no JSON object"
    );
  });

  it("throws when verdict is invalid", async () => {
    const executor = vi.fn().mockResolvedValue(
      '{"verdict": "maybe", "reasoning": "hmm"}'
    );

    await expect(callJudge("resp", criteria, executor)).rejects.toThrow(
      'Judge returned invalid verdict: "maybe"'
    );
  });

  it("retries once on parse failure then succeeds", async () => {
    const executor = vi.fn()
      .mockResolvedValueOnce("bad json")
      .mockResolvedValueOnce('{"verdict": "pass", "reasoning": "ok"}');

    const result = await callJudge("resp", criteria, executor);
    expect(result.verdict).toBe("pass");
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("throws first parse error when retry also fails", async () => {
    const executor = vi.fn().mockResolvedValue("bad json always");

    await expect(callJudge("resp", criteria, executor)).rejects.toThrow(
      "Judge returned no JSON object"
    );
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("wraps executor errors with prefix", async () => {
    const executor = vi.fn().mockRejectedValue(new Error("Network error"));

    await expect(callJudge("resp", criteria, executor)).rejects.toThrow(
      "Judge executor failed: Network error"
    );
  });
});
