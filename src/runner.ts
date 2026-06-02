import type {
  AgentExecutor,
  AgentResponse,
  CostSource,
  JudgeResult,
  RunResult,
  SceneDefinition,
  SceneResult,
  TimelineEvent,
} from "./types";
import type { JudgeConfig } from "./config";
import { collectPendingJudgements } from "./assertions";
import { callJudge, resolveJudgeExecutor } from "./judge";
import { resolveValue, resolveText, serializeValue, navigatePath } from "./resolve";
import { validateAgainstSchema } from "./schema";
import { wilsonInterval } from "./reports";

const DEFAULT_SCENE_TIMEOUT = 10_000;

/**
 * Extract a named field from an agent response for assertion.
 * - "response" / "value" → the native structured value (deterministic matchers)
 * - "text"               → the serialized/judge view (lazy; text matchers)
 * - "metadata"/"refusal" → the corresponding response property
 * - dot-path             → navigated into the structured value first
 *                          (e.g. "plan_items.0.options"), falling back to
 *                          metadata so existing metadata paths keep resolving.
 */
export function extractField<T>(response: AgentResponse<T>, field: string): unknown {
  switch (field) {
    case "response":
    case "value":
      return resolveValue(response);
    case "text":
      return resolveText(response);
    case "metadata":
      return response.metadata;
    case "refusal":
      return response.refusal;
    default: {
      const fromValue = navigatePath(resolveValue(response), field);
      if (fromValue !== undefined) return fromValue;
      return navigatePath(response.metadata ?? {}, field);
    }
  }
}

async function executeSingleRun<T>(
  executor: AgentExecutor<T>,
  scene: SceneDefinition,
  timeoutMs: number,
  turns: number,
  judgeConfig?: JudgeConfig,
): Promise<RunResult<T>> {
  // The empty sentinel uses the `text` branch of the union so it is a valid
  // AgentResponse<T> for ANY T (there is no native value yet — the executor
  // hasn't run). Using `{ value: "" }` would wrongly assume T = string.
  let response: AgentResponse<T> = { text: "" };
  let duration: number;

  try {
    const start = performance.now();
    const input = scene.prompt;
    for (let t = 0; t < turns; t++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await executor(input, { signal: controller.signal });
      } catch (err) {
        if ((err as Error).name === "AbortError" || controller.signal.aborted) {
          throw new Error(`Scene timed out after ${timeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
      if (response.executionError) break;
    }
    duration = performance.now() - start;
  } catch (err) {
    return {
      passed: false,
      error: (err as Error).message,
      response: { text: "", executionError: (err as Error).message },
      duration: 0,
    };
  }

  if (response.executionError) {
    return { passed: false, error: response.executionError, response, duration };
  }

  let passed = true;
  let error: string | undefined;
  let judgement: JudgeResult | undefined;

  // Schema validation runs first — a structural failure is the headline. Skip
  // refusals (which legitimately won't match the output shape) and empty values.
  if (scene.schema && !response.refusal) {
    const value = resolveValue(response);
    if (value !== undefined) {
      const outcome = await validateAgainstSchema(scene.schema, value);
      if (!outcome.ok) {
        passed = false;
        error = `Schema validation failed — ${outcome.message}`;
      }
    }
  }

  for (const assertion of scene.assertions) {
    if (!passed) break;
    try {
      const value = extractField(response, assertion.field);
      assertion.fn(value);
    } catch (err) {
      passed = false;
      error = (err as Error).message;
      break;
    }
  }

  const pending = collectPendingJudgements();

  if (pending.length > 0 && passed) {
    if (!judgeConfig) {
      passed = false;
      error = "judgedBy() requires a judge configured in agest.config.ts";
    } else {
      const judgeExecutor = resolveJudgeExecutor(judgeConfig);
      for (const p of pending) {
        try {
          // Hand the judge the serialized text view — NOT String(value),
          // which would render a structured value as "[object Object]".
          const result = await callJudge(serializeValue(p.value), p.criteria, judgeExecutor);
          judgement = result;
          if (result.verdict === "fail" || result.verdict === "partial") {
            passed = false;
            error = `Judge verdict: ${result.verdict} — ${result.reasoning}`;
            break;
          }
        } catch (err) {
          passed = false;
          error = `Judge error: ${(err as Error).message}`;
          break;
        }
      }
    }
  }

  return { passed, error, response, duration, judgement };
}

export async function executeScene<T = string>(
  executor: AgentExecutor<T>,
  scene: SceneDefinition,
  globalTimeout?: number,
  judgeConfig?: JudgeConfig,
  globalTurns?: number,
  globalRuns?: number,
): Promise<SceneResult<T>> {
  const timeoutMs = scene.timeout ?? globalTimeout ?? DEFAULT_SCENE_TIMEOUT;
  const turns = scene.turns ?? globalTurns ?? 1;
  const numRuns = scene.runs ?? globalRuns ?? 1;

  // Single run — original fast path
  if (numRuns <= 1) {
    const run = await executeSingleRun(executor, scene, timeoutMs, turns, judgeConfig);
    const tokens = run.response.metadata?.tokens;
    const cost = run.response.metadata?.cost;
    const events = run.response.metadata?.events;
    return {
      prompt: scene.prompt,
      response: run.response,
      duration: run.duration,
      passed: run.passed,
      error: run.error,
      judgement: run.judgement,
      suite: scene.suite,
      tags: scene.tags,
      tokens: tokens ? { input: tokens.input, output: tokens.output } : undefined,
      costUsd: cost?.totalUsd,
      costSource: cost?.source,
      events: events && events.length ? events : undefined,
    };
  }

  // Multiple runs — execute N times and aggregate
  const runs: RunResult<T>[] = [];
  for (let i = 0; i < numRuns; i++) {
    runs.push(await executeSingleRun(executor, scene, timeoutMs, turns, judgeConfig));
  }

  const passes = runs.filter((r) => r.passed).length;
  const passRate = passes / runs.length;
  const totalDuration = runs.reduce((sum, r) => sum + r.duration, 0);
  const statisticalSignificance = wilsonInterval(passes, runs.length).low;

  // Use the last run's response as representative
  const lastRun = runs[runs.length - 1];
  // Overall pass = majority passed (> 50%)
  const overallPassed = passRate > 0.5;
  const failedRuns = runs.filter((r) => !r.passed);
  const error = overallPassed
    ? undefined
    : failedRuns[0]?.error ?? "Majority of runs failed";

  // Aggregate tokens, cost, events across runs
  let inputTokens = 0;
  let outputTokens = 0;
  let hasTokens = false;
  let costTotal = 0;
  let hasCost = false;
  let costSource: CostSource | undefined;
  const allEvents: TimelineEvent[] = [];

  runs.forEach((r, runIndex) => {
    const meta = r.response.metadata;
    if (meta?.tokens) {
      hasTokens = true;
      inputTokens += meta.tokens.input;
      outputTokens += meta.tokens.output;
    }
    if (meta?.cost?.totalUsd != null) {
      hasCost = true;
      costTotal += meta.cost.totalUsd;
      // Promote weakest source: provider > table > unavailable
      if (costSource !== "table") costSource = meta.cost.source;
      if (meta.cost.source === "table" && costSource !== "table") {
        costSource = "table";
      }
    }
    if (meta?.events?.length) {
      for (const e of meta.events) {
        allEvents.push({ ...e, runIndex });
      }
    }
  });

  return {
    prompt: scene.prompt,
    response: lastRun.response,
    duration: totalDuration,
    passed: overallPassed,
    error,
    judgement: lastRun.judgement,
    suite: scene.suite,
    tags: scene.tags,
    runs,
    passRate,
    statisticalSignificance,
    tokens: hasTokens ? { input: inputTokens, output: outputTokens } : undefined,
    costUsd: hasCost ? costTotal : undefined,
    costSource,
    events: allEvents.length ? allEvents : undefined,
  };
}
