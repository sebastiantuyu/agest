import type { StandardSchemaV1 } from "./schema.js";
import type { AreaTag } from "./area-tags.js";

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
  /** Capability areas this scene exercises (cross-cutting, many-to-many). */
  tags?: AreaTag[];
  /** Standard Schema validated against the native value before user assertions. */
  schema?: StandardSchemaV1;
}

// ---------------------------------------------------------------------------
// Capability areas — "coverage for agent testing"
// ---------------------------------------------------------------------------

export interface AreaSpec {
  /** Confidence target: min DISTINCT scenes for the area's pass rate to be trustworthy. */
  minScenes?: number;
  /**
   * RESERVED — never invoked in v1. Future auto-detection hook so a catalog
   * entry (or a community preset) can claim a scene without an explicit tag.
   */
  detect?: (result: SceneResult<any>) => boolean;
}

export interface AreaCatalogEntry extends AreaSpec {
  id: string;
  description: string;
}

/** Per-area roll-up persisted on the report + checkpoint. */
export interface AreaCoverage {
  id: string;
  /** Distinct tagged scenes for this area. */
  scenes: number;
  /** Distinct scenes that passed. */
  passed: number;
  /** passed / scenes, 0 when scenes === 0. */
  passRate: number;
  /** Σ runs across this area's scenes (scenes×runs) — the Wilson trial basis. */
  trials: number;
  /** Passing trials. */
  trialPasses: number;
  /** Catalog area vs open domain tag. */
  inCatalog: boolean;
  /** Resolved confidence target carried through for rendering. */
  minScenes?: number;
}

export interface SuiteAreaCoverage {
  suite: string;
  areas: AreaCoverage[];
}

/** The `areas` block in agest.config.ts. */
export interface AreasConfig {
  /** Preset ids to compose, e.g. ["agest/recommended"]. Unknown id throws. */
  extends?: string[];
  /** Extra areas to opt in — id only, or id + a minScenes override. */
  include?: Array<string | { id: string; minScenes?: number }>;
  /** Area ids to drop from the opted-in set. */
  exclude?: string[];
}

export type JudgeVerdict = "pass" | "fail" | "partial";

export interface JudgeResult {
  verdict: JudgeVerdict;
  reasoning: string;
  criteria: string;
}

/**
 * One assertion (or the schema check) as it was evaluated against a scene's
 * response. `field` is the path the assertion read (e.g. "slots.cena.options",
 * or the synthetic "schema"). `actualValue` is the exact, safe-serialized input
 * the predicate received — captured on failure so a red case is diagnosable
 * from the artifact without a re-run. Omitted for the top-level value/text
 * fields (carried whole on the artifact) via a sentinel.
 */
export interface AssertionRecord {
  field: string;
  passed: boolean;
  message?: string;
  actualValue?: string;
}

export interface RunResult<T = string> {
  passed: boolean;
  error?: string;
  response: AgentResponse<T>;
  duration: number;
  judgement?: JudgeResult;
  /** Per-assertion (+ schema) records evaluated during this run. */
  assertions?: AssertionRecord[];
}

export interface SceneResult<T = string> {
  prompt: string;
  response: AgentResponse<T>;
  duration: number;
  passed: boolean;
  error?: string;
  judgement?: JudgeResult;
  suite?: string;
  /** Capability areas this scene exercises (carried from the definition). */
  tags?: string[];
  /**
   * Per-assertion (+ schema) records for the representative run. For a multi-run
   * scene this is the first failing run when the scene failed, else the last run
   * — kept consistent with the surfaced `error`.
   */
  assertions?: AssertionRecord[];
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
  /** Cases that passed (totalCases - failures). Persisted for statistical honesty. */
  casesPassed?: number;
  /** Configured runs per scene (sampling count) — affects the trial basis below. */
  runsPerScene?: number;
  /** Wilson score interval (95%) across all trials = Σ scene runs. */
  wilsonLow?: number;
  wilsonHigh?: number;
  averageInputTokensPerCase?: number;
  averageOutputTokensPerCase?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
  /** Per-area coverage roll-up across every scene in this run. */
  areaCoverage?: AreaCoverage[];
  /** Same roll-up partitioned by suite (omitted when the run has no suites). */
  areaCoverageBySuite?: SuiteAreaCoverage[];
  /** Area ids opted into via config — the expected set the roll-up is measured against. */
  areasOptedIn?: string[];
  /** Scenes carrying no tags (counted toward no area). */
  untaggedCount?: number;
  results: SceneResult<T>[];
}

/**
 * One append-only line in `.reports/checkpoints.jsonl` — the canonical run log.
 * Lightweight (cost + identity + stats), written on every run. Structured fields
 * (`dimensions`, `tools`) stay native; adding a field later needs no migration.
 */
export interface CheckpointRecord {
  runId: string;
  sweepId?: string;
  timestamp: string;
  agentName?: string;
  model?: string;
  systemPromptHash?: string;
  tools?: string[];
  /** Config identity map: { suiteHash, model, prompt, tools, judge, runs }. */
  dimensions: Record<string, string>;
  runsPerScene?: number;
  totalCases: number;
  casesPassed: number;
  successRate: number;
  wilsonLow?: number;
  wilsonHigh?: number;
  durationMs: number;
  costUsd?: number | null;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  avgInputTokensPerCase?: number;
  avgOutputTokensPerCase?: number;
  /** Per-area coverage roll-up — read back by `agest coverage`, grouped by sweepId. */
  areaCoverage?: AreaCoverage[];
  areaCoverageBySuite?: SuiteAreaCoverage[];
  areasOptedIn?: string[];
  untaggedCount?: number;
  /** Relative path to the full YAML snapshot, set only when run with --record. */
  recordPath?: string;
  /**
   * Relative path to this run's per-case artifact dir
   * (`.reports/sweeps/<sweep>/runs/<runId>`). Set whenever per-case artifacts
   * were written — the forward-link a future detail loader can follow.
   */
  artifactsDir?: string;
}

/**
 * The per-case artifact written under `runs/<runId>/cases/<slug>.json` for
 * EVERY scene (pass and fail). Carries the agent's resolved response so a run
 * stays inspectable later without a re-run — the diagnosis store. Derived
 * purely from a `SceneResult` (see `buildCaseArtifact`).
 */
export interface CaseArtifact {
  prompt: string;
  suite?: string;
  passed: boolean;
  /** The agent's native output (resolveValue) — raw, serialized once at write time. */
  resolvedValue: unknown;
  /** The serialized text view (resolveText) — what the judge / text matchers saw. */
  text: string;
  judge?: JudgeResult;
  assertions: AssertionRecord[];
  error?: string;
  tokens?: { input: number; output: number };
  costUsd?: number;
  durationMs: number;
  /** Multi-run only. */
  passRate?: number;
  significance?: number;
  runBreakdown?: Array<{ index: number; passed: boolean; error?: string }>;
}
