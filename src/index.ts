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

const pendingAgents: Promise<AgentReport>[] = [];
let autoRunScheduled = false;

/** @internal reset auto-run state between tests */
export function _resetAutoRun(): void {
  pendingAgents.length = 0;
  autoRunScheduled = false;
}

export function agent(
  executor: AgentExecutor,
  fn: () => void,
  options?: AgentOptions
): Promise<AgentReport> {
  const ctx = new AgentContext(executor, options?.name);
  setContext(ctx);

  try {
    fn();
  } catch (err) {
    setContext(null);
    return Promise.reject(err);
  }

  setContext(null);

  const promise = ctx.execute();
  pendingAgents.push(promise);

  if (!autoRunScheduled) {
    autoRunScheduled = true;
    process.nextTick(async () => {
      try {
        await Promise.all(pendingAgents);
      } catch {
        process.exitCode = 1;
      }
    });
  }

  return promise;
}
