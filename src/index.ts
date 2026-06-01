import type { AgentExecutor, AgentReport, HookFn } from "./types";
import { AgentContext, SceneBuilder, setContext, getContext } from "./context";
import { isStandardSchema, type StandardSchemaV1, type InferOutput } from "./schema";

export { expect } from "./assertions";
export type { StandardSchemaV1, InferOutput } from "./schema";
export { logger } from "./logger";
export { defineConfig } from "./config";
export { createTrace, summarizeEvents } from "./adapters/tracing";
export type { Trace } from "./adapters/tracing";
export type { AgestConfig, JudgeConfig, JudgeExecutor } from "./config";
export type { LogLevel } from "./logger";
export type { AgentExpectation, AgentMatchers } from "./assertions";
export type { JudgeCriteria } from "./judge";
export { CATALOG as areaCatalog, PRESETS as areaPresets, resolveAreas } from "./areas";
export type {
  AgentExecutor,
  ExecutorOptions,
  AgentResponse,
  AgentReport,
  SceneResult,
  RunResult,
  JudgeVerdict,
  JudgeResult,
  HookFn,
  TimelineEvent,
  TimelineEventKind,
  CostBreakdown,
  CostSource,
  AreaSpec,
  AreaCatalogEntry,
  AreaCoverage,
  SuiteAreaCoverage,
  AreasConfig,
} from "./types";

export interface AgentOptions {
  name?: string;
}

/**
 * Registers a scene in the active agent. The variant passed to an `agent()`
 * callback is typed `SceneFn<T>`, so `.expect("value", …)` receives the agent's
 * native value type.
 */
export type SceneFn<T = string> = (prompt: string) => SceneBuilder<T>;

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

const pendingAgents: Promise<AgentReport<any>>[] = [];
let autoRunScheduled = false;
let executionChain: Promise<void> = Promise.resolve();

/** @internal reset auto-run state between tests */
export function _resetAutoRun(): void {
  pendingAgents.length = 0;
  autoRunScheduled = false;
  executionChain = Promise.resolve();
}

export function agent<T = string>(
  executor: AgentExecutor<T>,
  fn: (scene: SceneFn<T>) => void,
  options?: AgentOptions
): Promise<AgentReport<T>>;
/**
 * Schema-typed agent: the executor's `value` type is inferred from the schema
 * (e.g. `z.infer<typeof Schema>`), and every non-refusal scene is validated
 * against it. The scene fn passed to the callback is typed accordingly, so
 * `.expect("value", …)` receives that value type. A scene's own
 * `.expectSchema()` overrides the agent schema.
 */
export function agent<S extends StandardSchemaV1>(
  schema: S,
  executor: AgentExecutor<InferOutput<S>>,
  fn: (scene: SceneFn<InferOutput<S>>) => void,
  options?: AgentOptions
): Promise<AgentReport<InferOutput<S>>>;
export function agent(
  ...args:
    | [StandardSchemaV1, AgentExecutor<any>, (scene: SceneFn<any>) => void, AgentOptions?]
    | [AgentExecutor<any>, (scene: SceneFn<any>) => void, AgentOptions?]
): Promise<AgentReport<any>> {
  const [schema, executor, fn, options] = isStandardSchema(args[0])
    ? (args as [StandardSchemaV1, AgentExecutor<any>, (scene: SceneFn<any>) => void, AgentOptions?])
    : ([undefined, ...(args as [AgentExecutor<any>, (scene: SceneFn<any>) => void, AgentOptions?])] as [
        undefined,
        AgentExecutor<any>,
        (scene: SceneFn<any>) => void,
        AgentOptions?,
      ]);

  const ctx = new AgentContext<any>(executor, options?.name, schema);
  setContext(ctx);

  try {
    // Hand the callback a scene fn bound to the active context. Its static type
    // carries T (via the overloads); at runtime it's the same `scene()`.
    fn(scene);
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
