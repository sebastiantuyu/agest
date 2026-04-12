export type AgentExecutor = (input: string) => Promise<AgentResponse>;

export interface AgentResponse {
  text: string;
  refusal?: boolean;
  executionError?: string;
  metadata?: {
    model?: string;
    tokens?: { input: number; output: number };
    tools?: string[];
    systemPrompt?: string;
    [key: string]: unknown;
  };
}

export interface SceneDefinition {
  prompt: string;
  assertions: Array<{ field: string; fn: (value: any) => void }>;
  timeout?: number;
  turns?: number;
}

export type JudgeVerdict = "pass" | "fail" | "partial";

export interface JudgeResult {
  verdict: JudgeVerdict;
  reasoning: string;
  criteria: string;
}

export interface SceneResult {
  prompt: string;
  response: AgentResponse;
  duration: number;
  passed: boolean;
  error?: string;
  judgement?: JudgeResult;
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
  results: SceneResult[];
}
