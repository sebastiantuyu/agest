import type { AgentExecutor, AgentResponse } from "../types";

export interface RemoteAdapterOptions {
  /** HTTP headers (e.g. Authorization) */
  headers?: Record<string, string>;
  /** HTTP method, defaults to POST */
  method?: "POST" | "PUT" | "GET";
  /**
   * Extra fields merged into the request body.
   * Merged *under* the output of `buildRequest`, so `buildRequest` wins on conflicts.
   * Ignored when method is GET.
   */
  body?: Record<string, unknown>;
  /**
   * Build the request body from the input prompt.
   * Defaults to `{ prompt: input }`.
   */
  buildRequest?: (input: string) => unknown;
  /**
   * Parse the raw response body into an AgentResponse.
   * When omitted the adapter tries common shapes:
   * - `{ text }` / `{ response }` / `{ output }` / `{ message }` / plain string
   */
  parseResponse?: <TBody = unknown>(body: TBody) => AgentResponse;
  /**
   * Static metadata for this remote agent.
   * Because the remote endpoint is opaque, metadata like model name,
   * tools, and system prompt must be provided manually here.
   */
  metadata?: {
    model?: string;
    tokens?: { input: number; output: number };
    tools?: string[];
    systemPrompt?: string;
    [key: string]: unknown;
  };
}

/**
 * Adapter for remote agents exposed via HTTP endpoints.
 *
 * Since the remote agent is a black box, metadata (model, tools, etc.)
 * must be supplied manually through `options.metadata`. If the endpoint
 * returns token usage or other metadata, provide a `parseResponse`
 * function to extract it.
 *
 * @example
 * ```ts
 * import { remote } from "agest/adapters";
 *
 * const executor = remote("https://my-agent.example.com/chat", {
 *   headers: { Authorization: "Bearer sk-..." },
 *   metadata: { model: "gpt-4o", tools: ["search", "calculator"] },
 * });
 *
 * await agent(executor, () => {
 *   scene("What is 2+2?").expect("response", (r) => {
 *     expect(r).toBe.containing("4");
 *   });
 * });
 * ```
 */
export function remote(
  endpoint: string,
  options: RemoteAdapterOptions = {},
): AgentExecutor {
  const {
    headers = {},
    method = "POST",
    body: extraBody,
    buildRequest = defaultBuildRequest,
    parseResponse,
    metadata: staticMetadata,
  } = options;

  return async (input: string): Promise<AgentResponse> => {
    let res: Response;
    try {
      const fetchOptions: RequestInit = {
        method,
        headers: { "Content-Type": "application/json", ...headers },
      };

      if (method !== "GET") {
        const built = buildRequest(input);
        const merged =
          extraBody && typeof built === "object" && built !== null
            ? { ...extraBody, ...(built as Record<string, unknown>) }
            : extraBody && typeof built !== "object"
              ? { ...extraBody, prompt: built }
              : built;
        fetchOptions.body = JSON.stringify(merged);
      }

      res = await fetch(endpoint, fetchOptions);
    } catch (err) {
      return {
        text: "",
        executionError: `Request failed: ${(err as Error).message}`,
        metadata: staticMetadata,
      };
    }

    if (!res.ok) {
      return {
        text: "",
        executionError: `HTTP ${res.status}: ${res.statusText}`,
        metadata: staticMetadata,
      };
    }

    const contentType = res.headers.get("content-type") ?? "";
    let body: unknown;
    if (contentType.includes("application/json")) {
      body = await res.json();
    } else {
      body = await res.text();
    }

    if (parseResponse) {
      const parsed = parseResponse(body);
      return {
        ...parsed,
        metadata: { ...staticMetadata, ...parsed.metadata },
      };
    }

    const text = extractText(body);

    return {
      text,
      metadata: {
        ...staticMetadata,
        ...extractResponseMetadata(body),
      },
    };
  };
}

function defaultBuildRequest(input: string): unknown {
  return { prompt: input };
}

function extractText(body: unknown): string {
  if (typeof body === "string") return body;
  if (typeof body !== "object" || body === null) return String(body);

  const obj = body as Record<string, unknown>;

  for (const key of ["text", "response", "output", "message", "content", "answer"]) {
    if (typeof obj[key] === "string") return obj[key] as string;
  }

  // Try nested: { data: { text } }, { result: { output } }
  for (const wrapper of ["data", "result"]) {
    if (typeof obj[wrapper] === "object" && obj[wrapper] !== null) {
      const nested = obj[wrapper] as Record<string, unknown>;
      for (const key of ["text", "response", "output", "message", "content", "answer"]) {
        if (typeof nested[key] === "string") return nested[key] as string;
      }
    }
  }

  return JSON.stringify(body);
}

function extractResponseMetadata(
  body: unknown,
): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const obj = body as Record<string, unknown>;

  const meta: Record<string, unknown> = {};

  if (typeof obj.model === "string") meta.model = obj.model;

  // Try to find token usage in common locations
  const usage =
    obj.usage ?? obj.token_usage ?? obj.tokens ??
    (typeof obj.metadata === "object" && obj.metadata !== null
      ? (obj.metadata as Record<string, unknown>).usage ??
        (obj.metadata as Record<string, unknown>).tokens
      : undefined);

  if (typeof usage === "object" && usage !== null) {
    const u = usage as Record<string, unknown>;
    const input =
      (u.input_tokens ?? u.prompt_tokens ?? u.promptTokens ?? u.input) as number | undefined;
    const output =
      (u.output_tokens ?? u.completion_tokens ?? u.completionTokens ?? u.output) as number | undefined;
    if (input !== undefined || output !== undefined) {
      meta.tokens = { input: input ?? 0, output: output ?? 0 };
    }
  }

  if (typeof obj.refusal === "boolean") meta.refusal = obj.refusal;

  return Object.keys(meta).length > 0 ? meta : undefined;
}
