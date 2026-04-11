import type { AgentExecutor, AgentReport } from "./types";
import { AgentContext, SceneBuilder, setContext, getContext } from "./context";

export { expect } from "./assertions";
export { logger } from "./logger";
export type { LogLevel } from "./logger";
export type { AgentExpectation, AgentMatchers } from "./assertions";
export type {
  AgentExecutor,
  AgentResponse,
  AgentReport,
  SceneResult,
} from "./types";

export function scene(prompt: string): SceneBuilder {
  return getContext().registerScene(prompt);
}

export async function agent(
  executor: AgentExecutor,
  fn: () => void
): Promise<AgentReport> {
  const ctx = new AgentContext(executor);
  setContext(ctx);

  try {
    fn();
  } finally {
    setContext(null);
  }

  return ctx.execute();
}
