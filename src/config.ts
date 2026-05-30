import path from "path";

export type JudgeExecutor = (prompt: string) => Promise<string>;

export interface JudgeConfig {
  /** Model identifier passed to the OpenAI-compatible API. Defaults to "openai/gpt-oss-20b". */
  model?: string;
  /** API key. Defaults to OPENROUTER_API_KEY then OPENAI_API_KEY env vars. */
  apiKey?: string;
  /** Base URL for the chat completions endpoint. Defaults to "https://openrouter.ai/api/v1". */
  baseUrl?: string;
  /** Fully custom judge function. When provided, model/apiKey/baseUrl are ignored. */
  executor?: JudgeExecutor;
}

export interface AgestConfig {
  parallelism?: number;
  timeout?: number;
  turns?: number;
  runs?: number;
  judge?: JudgeConfig;
  /**
   * Per-model pricing override (USD per 1M tokens). Merged on top of the
   * built-in `src/pricing/models.json` table. Provide entries for any model
   * you use that isn't already in the table, or to override a default.
   */
  pricing?: Record<string, { input: number; output: number }>;
}

export function defineConfig(config: AgestConfig): AgestConfig {
  return config;
}

export async function loadConfig(): Promise<AgestConfig> {
  const candidates = [
    path.join(process.cwd(), "agest.config.ts"),
    path.join(process.cwd(), "agest.config.js"),
  ];

  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      return (mod.default ?? mod) as AgestConfig;
    } catch {
    }
  }

  return {};
}
