import type { AgentExecutor, AgentResponse, JudgeResult, RunResult, SceneDefinition, SceneResult } from "./types";
import type { JudgeConfig } from "./config";
import { collectPendingJudgements } from "./assertions";
import { callJudge, resolveJudgeExecutor } from "./judge";

const DEFAULT_SCENE_TIMEOUT = 10_000;

export function extractField(response: AgentResponse, field: string): unknown {
  switch (field) {
    case "response":
      return response.text;
    case "metadata":
      return response.metadata;
    case "refusal":
      return response.refusal;
    default:
      return response.metadata?.[field];
  }
}

/**
 * Compute Wilson score interval lower bound.
 * Measures confidence that the true pass rate is above 50% (random chance).
 * z = 1.96 for 95% confidence level.
 */
function wilsonSignificance(passes: number, total: number): number {
  if (total === 0) return 0;
  const z = 1.96;
  const p = passes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  const lower = (centre - spread) / denominator;
  // Return the lower bound clamped to [0, 1]
  return Math.max(0, Math.min(1, lower));
}

async function executeSingleRun(
  executor: AgentExecutor,
  scene: SceneDefinition,
  timeoutMs: number,
  turns: number,
  judgeConfig?: JudgeConfig,
): Promise<RunResult> {
  let response: AgentResponse = { text: "" };
  let duration: number;

  try {
    const start = performance.now();
    let input = scene.prompt;
    for (let t = 0; t < turns; t++) {
      let timer: ReturnType<typeof setTimeout>;
      response = await Promise.race([
        executor(input).finally(() => clearTimeout(timer)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Scene timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      if (response.executionError) break;
      if (t < turns - 1) input = response.text;
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

  for (const assertion of scene.assertions) {
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
          const result = await callJudge(String(p.value), p.criteria, judgeExecutor);
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

export async function executeScene(
  executor: AgentExecutor,
  scene: SceneDefinition,
  globalTimeout?: number,
  judgeConfig?: JudgeConfig,
  globalTurns?: number,
): Promise<SceneResult> {
  const timeoutMs = scene.timeout ?? globalTimeout ?? DEFAULT_SCENE_TIMEOUT;
  const turns = scene.turns ?? globalTurns ?? 1;
  const numRuns = scene.runs ?? 1;

  // Single run — original fast path
  if (numRuns <= 1) {
    const run = await executeSingleRun(executor, scene, timeoutMs, turns, judgeConfig);
    return {
      prompt: scene.prompt,
      response: run.response,
      duration: run.duration,
      passed: run.passed,
      error: run.error,
      judgement: run.judgement,
      suite: scene.suite,
    };
  }

  // Multiple runs — execute N times and aggregate
  const runs: RunResult[] = [];
  for (let i = 0; i < numRuns; i++) {
    runs.push(await executeSingleRun(executor, scene, timeoutMs, turns, judgeConfig));
  }

  const passes = runs.filter((r) => r.passed).length;
  const passRate = passes / runs.length;
  const totalDuration = runs.reduce((sum, r) => sum + r.duration, 0);
  const statisticalSignificance = wilsonSignificance(passes, runs.length);

  // Use the last run's response as representative
  const lastRun = runs[runs.length - 1];
  // Overall pass = majority passed (> 50%)
  const overallPassed = passRate > 0.5;
  const failedRuns = runs.filter((r) => !r.passed);
  const error = overallPassed
    ? undefined
    : failedRuns[0]?.error ?? "Majority of runs failed";

  return {
    prompt: scene.prompt,
    response: lastRun.response,
    duration: totalDuration,
    passed: overallPassed,
    error,
    judgement: lastRun.judgement,
    suite: scene.suite,
    runs,
    passRate,
    statisticalSignificance,
  };
}
