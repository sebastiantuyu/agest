export interface ExecutorOptions {
  signal?: AbortSignal;
}

export type AgentExecutor<T = string> = (
  input: string,
  options?: ExecutorOptions,
) => Promise<AgentResponse<T>>;

export type CostSource = "provider" | "table" | "unavailable";

export interface CostBreakdown {
  inputUsd?: number;
  outputUsd?: number;
  totalUsd?: number;
  source: CostSource;
}

export type TimelineEventKind = "model" | "tool";

export interface TimelineEvent {
  kind: TimelineEventKind;
  name: string;
  /** ms relative to the scene start */
  startMs: number;
  endMs: number;
  durationMs: number;
  tokens?: { input: number; output: number };
  /** Prompt-cache-hit input tokens (subset of tokens.input), when reported by the provider */
  cachedInputTokens?: number;
  cost?: CostBreakdown;
  /** Index of the run this event belongs to (only set when aggregating across multi-run scenes) */
  runIndex?: number;
  error?: string;
}

/**
 * The result an executor hands back. EXACTLY ONE of `value` / `text` is
 * required (both may be present); the rest are optional.
 *
 * `value` is the agent's NATIVE output and the source of truth for
 * deterministic, structural assertions — a string for a chat agent, an object
 * for a structured agent (a plan, a tool-call payload, parsed JSON). It is
 * never coerced to a string before a matcher asks for text.
 *
 * `text` is a pre-serialized projection for the judge model and the text
 * matchers (`containing`, `matchingPattern`, `refusal`). A string-producing
 * agent can return ONLY `text` (the legacy/common case) — it is then also used
 * as `value`. A structured agent returns `value` and, optionally, an enriched
 * `text` when the judge needs a view the raw value can't give cheaply (e.g.
 * resolving opaque ids to names). When `text` is omitted, agest serializes
 * `value` lazily (string passthrough, else JSON). See `resolve.ts`.
 *
 * The generic defaults to `string`, so the common chat case stays
 * `{ text: "..." }` or `{ value: "..." }` with no type ceremony.
 */
export type AgentResponse<T = string> = AgentResponseBase<T> &
  ({ value: T } | { text: string });

interface AgentResponseBase<T = string> {
  value?: T;
  /** Pre-serialized view for the judge / text matchers. */
  text?: string;
  refusal?: boolean;
  executionError?: string;
  metadata?: {
    model?: string;
    tokens?: { input: number; output: number };
    tools?: string[];
    systemPrompt?: string;
    events?: TimelineEvent[];
    cost?: CostBreakdown;
    [key: string]: unknown;
  };
}

export type HookFn = () => void | Promise<void>;

export interface SceneDefinition {
  prompt: string;
  assertions: Array<{ field: string; fn: (value: any) => void }>;
  timeout?: number;
  turns?: number;
  runs?: number;
  suite?: string;
}

export type JudgeVerdict = "pass" | "fail" | "partial";

export interface JudgeResult {
  verdict: JudgeVerdict;
  reasoning: string;
  criteria: string;
}

export interface RunResult<T = string> {
  passed: boolean;
  error?: string;
  response: AgentResponse<T>;
  duration: number;
  judgement?: JudgeResult;
}

export interface SceneResult<T = string> {
  prompt: string;
  response: AgentResponse<T>;
  duration: number;
  passed: boolean;
  error?: string;
  judgement?: JudgeResult;
  suite?: string;
  runs?: RunResult<T>[];
  passRate?: number;
  statisticalSignificance?: number;
  /** Aggregate tokens across all runs of this scene */
  tokens?: { input: number; output: number };
  /** Aggregate USD cost across all runs of this scene */
  costUsd?: number;
  costSource?: CostSource;
  /** Ordered timeline events from every run of the scene */
  events?: TimelineEvent[];
}

export interface AgentReport<T = string> {
  name?: string;
  model?: string;
  systemPromptHash?: string;
  promptHash?: string;
  dimensions?: Record<string, string>;
  tools?: string[];
  successRate: number;
  failedCases: string[];
  failedCaseErrors: Record<string, string>;
  timestamp: string;
  duration: number;
  totalCases: number;
  averageInputTokensPerCase?: number;
  averageOutputTokensPerCase?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
  results: SceneResult<T>[];
}
