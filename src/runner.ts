import type { AgentExecutor, AgentResponse, SceneDefinition, SceneResult } from "./types";

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
  scene: SceneDefinition
): Promise<SceneResult> {
  let response: AgentResponse;
  let duration: number;

  try {
    const start = performance.now();
    response = await executor(scene.prompt);
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

  return { prompt: scene.prompt, response, duration, passed, error };
}
