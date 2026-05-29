import type { TimelineEvent, CostBreakdown } from "../types";
import { computeCost } from "../pricing";
import { logger } from "../logger";

type RunId = string;

interface OpenLLM {
  startMs: number;
  name?: string;
}

interface OpenTool {
  startMs: number;
  name: string;
}

export interface TracingHandle {
  /** Pass this into `runnable.invoke(..., { callbacks: [handler.callbacks] })` */
  callbacks: any[];
  drain(): { events: TimelineEvent[]; modelName?: string };
}

/**
 * Creates a LangChain callback handler that records every LLM and tool
 * invocation as a `TimelineEvent`. Returns a handle whose `drain()` method
 * yields the captured events with `startMs` / `endMs` relative to the
 * provided baseline.
 *
 * Designed to fail open: any unexpected callback shape is ignored rather
 * than throwing — the underlying agent run must not be broken by tracing.
 */
export async function createTracingHandle(baselineMs: number): Promise<TracingHandle> {
  // Import lazily so the adapter still works when @langchain/core is not present.
  // BaseCallbackHandler is the runtime contract LangChain checks for.
  let BaseCallbackHandler: any;
  try {
    ({ BaseCallbackHandler } = await import("@langchain/core/callbacks/base"));
  } catch (err) {
    logger.debug(
      `[agest] tracing disabled: could not load @langchain/core/callbacks/base — ` +
        `install @langchain/core as a peer to capture per-scene cost/timeline. (${(err as Error).message})`
    );
    return { callbacks: [], drain: () => ({ events: [] }) };
  }

  const events: TimelineEvent[] = [];
  const openLLMs = new Map<RunId, OpenLLM>();
  const openTools = new Map<RunId, OpenTool>();
  let lastModelName: string | undefined;

  class AgestTracer extends BaseCallbackHandler {
    name = "AgestTracer";
    awaitHandlers = true;

    handleLLMStart(
      llm: any,
      _prompts: string[],
      runId: string,
      _parentRunId?: string,
      extraParams?: Record<string, unknown>,
    ): void {
      openLLMs.set(runId, {
        startMs: now() - baselineMs,
        name: extractModelName(llm, extraParams),
      });
    }

    handleChatModelStart(
      llm: any,
      _messages: unknown,
      runId: string,
      _parentRunId?: string,
      extraParams?: Record<string, unknown>,
    ): void {
      openLLMs.set(runId, {
        startMs: now() - baselineMs,
        name: extractModelName(llm, extraParams),
      });
    }

    handleLLMEnd(output: any, runId: string): void {
      const open = openLLMs.get(runId);
      if (!open) return;
      openLLMs.delete(runId);

      const endMs = now() - baselineMs;
      const tokens = extractTokensFromLLMOutput(output);
      const providerCost = extractProviderCost(output);
      const cachedInputTokens = extractCachedTokens(output);
      const name = open.name ?? extractModelNameFromOutput(output) ?? "model";
      if (name && name !== "model") lastModelName = name;

      const cost = computeCost({
        model: name,
        inputTokens: tokens?.input,
        outputTokens: tokens?.output,
        cachedInputTokens,
        providerCost,
      });

      events.push({
        kind: "model",
        name,
        startMs: open.startMs,
        endMs,
        durationMs: Math.max(0, endMs - open.startMs),
        tokens,
        cachedInputTokens,
        cost: stripCostIfEmpty(cost),
      });
    }

    handleLLMError(err: any, runId: string): void {
      const open = openLLMs.get(runId);
      if (!open) return;
      openLLMs.delete(runId);
      const endMs = now() - baselineMs;
      events.push({
        kind: "model",
        name: open.name ?? "model",
        startMs: open.startMs,
        endMs,
        durationMs: Math.max(0, endMs - open.startMs),
        error: err?.message ?? String(err),
      });
    }

    handleToolStart(
      tool: any,
      _input: string,
      runId: string,
      _parentRunId?: string,
      _tags?: string[],
      _metadata?: Record<string, unknown>,
      runName?: string,
    ): void {
      openTools.set(runId, {
        startMs: now() - baselineMs,
        name: extractToolName(tool, runName) ?? "tool",
      });
    }

    handleToolEnd(_output: any, runId: string): void {
      const open = openTools.get(runId);
      if (!open) return;
      openTools.delete(runId);
      const endMs = now() - baselineMs;
      events.push({
        kind: "tool",
        name: open.name,
        startMs: open.startMs,
        endMs,
        durationMs: Math.max(0, endMs - open.startMs),
      });
    }

    handleToolError(err: any, runId: string): void {
      const open = openTools.get(runId);
      if (!open) return;
      openTools.delete(runId);
      const endMs = now() - baselineMs;
      events.push({
        kind: "tool",
        name: open.name,
        startMs: open.startMs,
        endMs,
        durationMs: Math.max(0, endMs - open.startMs),
        error: err?.message ?? String(err),
      });
    }
  }

  const handler = new AgestTracer();
  return {
    callbacks: [handler],
    drain: () => {
      const ordered = [...events].sort((a, b) => a.startMs - b.startMs);
      events.length = 0;
      return { events: ordered, modelName: lastModelName };
    },
  };
}

export interface Trace {
  /**
   * Attach to your top-level LangChain/LangGraph call:
   * `await graph.invoke(input, { callbacks: trace.callbacks })`.
   * Callbacks propagate to nested nodes automatically.
   */
  callbacks: any[];
  /**
   * Collect the captured timeline plus aggregated tokens and cost. Call once
   * after the run completes; the result is memoized so repeat calls are safe.
   * Spread the result into your `AgentResponse.metadata` to surface the
   * per-scene cost/timeline waterfall in the report.
   */
  collect(): {
    events: TimelineEvent[];
    tokens?: { input: number; output: number };
    cost?: CostBreakdown;
  };
}

/**
 * Public tracing helper for custom executors (i.e. agents not wired through
 * the `langchain()` adapter). Create one per scene run, hand its `callbacks`
 * to your LangChain/LangGraph invocation, then spread `collect()` into the
 * response metadata.
 *
 * @example
 * ```ts
 * const trace = await createTrace({ model: env.OPENROUTER_MODEL });
 * const plan = await generatePlan(input, { callbacks: trace.callbacks });
 * return { text: render(plan), metadata: { model, tools, ...trace.collect() } };
 * ```
 */
export async function createTrace(opts?: { model?: string }): Promise<Trace> {
  const baseline = performance.now();
  const handle = await createTracingHandle(baseline);
  let collected: ReturnType<Trace["collect"]> | undefined;
  return {
    callbacks: handle.callbacks,
    collect() {
      if (collected) return collected;
      const drained = handle.drain();
      const { tokens, cost } = summarizeEvents(
        drained.events,
        opts?.model ?? drained.modelName
      );
      collected = { events: drained.events, tokens, cost };
      return collected;
    },
  };
}

/**
 * Aggregate token counts and cost across a timeline's model events.
 * Provider-reported cost wins; otherwise the table-derived cost; otherwise
 * cost is recomputed from `model` and the summed tokens. `fallbackTokens` is
 * used only when no model event carried usage.
 */
export function summarizeEvents(
  events: TimelineEvent[],
  model?: string,
  fallbackTokens?: { input: number; output: number }
): { tokens?: { input: number; output: number }; cost?: CostBreakdown } {
  const modelEvents = events.filter((e) => e.kind === "model");

  let inputTokens = 0;
  let outputTokens = 0;
  let providerCost = 0;
  let hasProviderCost = false;
  let hasTableCost = false;
  let tableCost = 0;
  let hasTokens = false;

  for (const e of modelEvents) {
    if (e.tokens) {
      hasTokens = true;
      inputTokens += e.tokens.input;
      outputTokens += e.tokens.output;
    }
    if (e.cost?.source === "provider" && e.cost.totalUsd != null) {
      hasProviderCost = true;
      providerCost += e.cost.totalUsd;
    } else if (e.cost?.source === "table" && e.cost.totalUsd != null) {
      hasTableCost = true;
      tableCost += e.cost.totalUsd;
    }
  }

  let tokens = hasTokens ? { input: inputTokens, output: outputTokens } : undefined;
  if (!tokens && fallbackTokens) tokens = fallbackTokens;

  let cost: CostBreakdown | undefined;
  if (hasProviderCost) {
    cost = { totalUsd: providerCost, source: "provider" };
  } else if (hasTableCost) {
    cost = { totalUsd: tableCost, source: "table" };
  } else if (tokens && model) {
    const computed = computeCost({
      model,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
    });
    if (computed.source !== "unavailable") cost = computed;
  }

  return { tokens, cost };
}

function now(): number {
  return performance.now();
}

function extractModelName(llm: any, extraParams?: Record<string, unknown>): string | undefined {
  const invocation = (extraParams?.invocation_params ?? {}) as Record<string, unknown>;
  if (typeof invocation.model === "string") return invocation.model;
  if (typeof invocation.model_name === "string") return invocation.model_name as string;

  const kwargs = llm?.kwargs as Record<string, unknown> | undefined;
  if (kwargs) {
    if (typeof kwargs.model === "string") return kwargs.model;
    if (typeof kwargs.model_name === "string") return kwargs.model_name as string;
    if (typeof kwargs.modelName === "string") return kwargs.modelName as string;
  }

  const id = llm?.id;
  if (Array.isArray(id) && id.length > 0 && typeof id[id.length - 1] === "string") {
    return id[id.length - 1] as string;
  }
  return undefined;
}

function extractModelNameFromOutput(output: any): string | undefined {
  const gen = output?.generations?.[0]?.[0];
  return (
    gen?.message?.response_metadata?.model_name ??
    gen?.message?.response_metadata?.model ??
    output?.llmOutput?.modelName ??
    output?.llmOutput?.model
  );
}

function extractTokensFromLLMOutput(
  output: any,
): { input: number; output: number } | undefined {
  const usage =
    output?.llmOutput?.tokenUsage ??
    output?.llmOutput?.usage ??
    output?.generations?.[0]?.[0]?.message?.usage_metadata ??
    output?.generations?.[0]?.[0]?.message?.response_metadata?.usage;

  if (!usage) return undefined;

  const input =
    usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens ?? 0;
  const out =
    usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens ?? 0;

  if (!input && !out) return undefined;
  return { input, output: out };
}

/** Collect the usage-bearing objects LangChain/OpenRouter may attach to an LLM result. */
function usageObjects(output: any): any[] {
  const msg = output?.generations?.[0]?.[0]?.message;
  return [
    output?.llmOutput?.usage,
    output?.llmOutput?.tokenUsage,
    output?.llmOutput?.estimatedTokenUsage,
    output?.llmOutput,
    msg?.usage_metadata,
    msg?.response_metadata?.usage,
    msg?.response_metadata?.tokenUsage,
    msg?.response_metadata?.estimatedTokenUsage,
    msg?.response_metadata,
    msg?.additional_kwargs?.usage,
  ].filter((u) => u && typeof u === "object");
}

/**
 * OpenRouter (with `usage: { include: true }`) reports real USD cost. LangChain
 * surfaces it inconsistently across versions, so scan the known usage objects
 * for a numeric `cost` / `total_cost`.
 */
function extractProviderCost(output: any): number | undefined {
  for (const u of usageObjects(output)) {
    const c =
      (typeof u.cost === "number" ? u.cost : undefined) ??
      (typeof u.total_cost === "number" ? u.total_cost : undefined) ??
      (typeof u.cost_usd === "number" ? u.cost_usd : undefined) ??
      (typeof u.cost_details?.upstream_inference_cost === "number"
        ? u.cost_details.upstream_inference_cost
        : undefined);
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return undefined;
}

/**
 * Cached (prompt-cache hit) input tokens, when the provider reports them.
 * Charged at a fraction of the normal input rate, so surfacing them lets the
 * report explain why provider cost is below the flat-table estimate.
 */
function extractCachedTokens(output: any): number | undefined {
  for (const u of usageObjects(output)) {
    const cached =
      u.input_token_details?.cache_read ??
      u.prompt_tokens_details?.cached_tokens ??
      u.cache_read_input_tokens ??
      u.cached_tokens;
    if (typeof cached === "number" && cached > 0) return cached;
  }
  return undefined;
}

const TOOL_CLASS_NAMES = new Set([
  "DynamicStructuredTool",
  "DynamicTool",
  "StructuredTool",
  "Tool",
]);

function extractToolName(tool: any, runName?: string): string | undefined {
  // `runName` is the actual tool name LangChain assigns the run (e.g.
  // "search_recipes"); prefer it over the serialized class name.
  if (runName && !TOOL_CLASS_NAMES.has(runName)) return runName;
  if (tool) {
    if (typeof tool.name === "string" && !TOOL_CLASS_NAMES.has(tool.name)) return tool.name;
    if (typeof tool.kwargs?.name === "string") return tool.kwargs.name;
    if (Array.isArray(tool.id) && tool.id.length > 0) {
      const last = String(tool.id[tool.id.length - 1]);
      if (!TOOL_CLASS_NAMES.has(last)) return last;
    }
    if (typeof tool.name === "string") return tool.name;
  }
  return runName;
}

function stripCostIfEmpty(cost: CostBreakdown): CostBreakdown | undefined {
  if (cost.source === "unavailable" && cost.totalUsd == null) return undefined;
  return cost;
}
