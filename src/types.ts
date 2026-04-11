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
}

export interface SceneResult {
  prompt: string;
  response: AgentResponse;
  duration: number;
  passed: boolean;
  error?: string;
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
