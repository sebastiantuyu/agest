import type { AgentExecutor, AgentReport } from "./types";
import { AgentContext, SceneBuilder, setContext, getContext } from "./context";

export { expect } from "./assertions";
export { logger } from "./logger";
export { defineConfig } from "./config";
export type { AgestConfig, JudgeConfig, JudgeExecutor } from "./config";
export type { LogLevel } from "./logger";
export type { AgentExpectation, AgentMatchers } from "./assertions";
export type { JudgeCriteria } from "./judge";
export type {
  AgentExecutor,
  AgentResponse,
  AgentReport,
  SceneResult,
  JudgeVerdict,
  JudgeResult,
} from "./types";

export interface AgentOptions {
  name?: string;
}

export function scene(prompt: string): SceneBuilder {
  return getContext().registerScene(prompt);
}

export async function agent(
  executor: AgentExecutor,
  fn: () => void,
  options?: AgentOptions
): Promise<AgentReport> {
  const ctx = new AgentContext(executor, options?.name);
  setContext(ctx);

  try {
    fn();
  } finally {
    setContext(null);
  }

  return ctx.execute();
}
