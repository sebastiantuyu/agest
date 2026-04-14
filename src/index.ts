import type { AgentExecutor, AgentReport, HookFn } from "./types";
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
  RunResult,
  JudgeVerdict,
  JudgeResult,
  HookFn,
} from "./types";

export interface AgentOptions {
  name?: string;
}

export function scene(prompt: string): SceneBuilder {
  return getContext().registerScene(prompt);
}

export function beforeAll(fn: HookFn): void {
  getContext().registerHook("beforeAll", fn);
}

export function afterAll(fn: HookFn): void {
  getContext().registerHook("afterAll", fn);
}

export function beforeEach(fn: HookFn): void {
  getContext().registerHook("beforeEach", fn);
}

export function afterEach(fn: HookFn): void {
  getContext().registerHook("afterEach", fn);
}

export function suite(name: string, fn: () => void): void {
  const ctx = getContext();
  ctx.setSuite(name);
  try {
    fn();
  } finally {
    ctx.clearSuite();
  }
}

const pendingAgents: Promise<AgentReport>[] = [];
let autoRunScheduled = false;
let executionChain: Promise<void> = Promise.resolve();

/** @internal reset auto-run state between tests */
export function _resetAutoRun(): void {
  pendingAgents.length = 0;
  autoRunScheduled = false;
  executionChain = Promise.resolve();
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

  const promise = executionChain.then(() => ctx.execute());
  executionChain = promise.then(() => {}, () => {});
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
