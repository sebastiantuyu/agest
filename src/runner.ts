import type { AgentExecutor, AgentResponse, JudgeResult, SceneDefinition, SceneResult } from "./types";
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

export async function executeScene(
  executor: AgentExecutor,
  scene: SceneDefinition,
  globalTimeout?: number,
  judgeConfig?: JudgeConfig,
  globalTurns?: number,
): Promise<SceneResult> {
  let response: AgentResponse = { text: "" };
  let duration: number;

  const timeoutMs = scene.timeout ?? globalTimeout ?? DEFAULT_SCENE_TIMEOUT;
  const turns = scene.turns ?? globalTurns ?? 1;

  try {
    const start = performance.now();
    let input = scene.prompt;
    for (let t = 0; t < turns; t++) {
      response = await Promise.race([
        executor(input),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Scene timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);
      if (response.executionError) break;
      if (t < turns - 1) input = response.text;
    }
    duration = performance.now() - start;
  } catch (err) {
    return {
      prompt: scene.prompt,
      response: { text: "", executionError: (err as Error).message },
      duration: 0,
      passed: false,
      error: (err as Error).message,
    };
  }

  if (response.executionError) {
    return {
      prompt: scene.prompt,
      response,
      duration,
      passed: false,
      error: response.executionError,
    };
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

  return { prompt: scene.prompt, response, duration, passed, error, judgement };
}
