export interface ExecutorOptions {
  signal?: AbortSignal;
}

export type AgentExecutor = (input: string, options?: ExecutorOptions) => Promise<AgentResponse>;

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
  cost?: CostBreakdown;
  /** Index of the run this event belongs to (only set when aggregating across multi-run scenes) */
  runIndex?: number;
  error?: string;
}

export interface AgentResponse {
  text: string;
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

export interface RunResult {
  passed: boolean;
  error?: string;
  response: AgentResponse;
  duration: number;
  judgement?: JudgeResult;
}

export interface SceneResult {
  prompt: string;
  response: AgentResponse;
  duration: number;
  passed: boolean;
  error?: string;
  judgement?: JudgeResult;
  suite?: string;
  runs?: RunResult[];
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

export interface AgentReport {
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
  results: SceneResult[];
}
