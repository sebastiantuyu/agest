import type { JudgeResult, JudgeVerdict } from "./types";
import type { JudgeConfig, JudgeExecutor } from "./config";

const DEFAULT_JUDGE_MODEL = "openai/gpt-oss-20b";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

function buildFetchExecutor(config: JudgeConfig): JudgeExecutor {
  const model = config.model ?? DEFAULT_JUDGE_MODEL;
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const apiKey =
    config.apiKey ??
    process.env.OPENROUTER_API_KEY ??
    process.env.OPENAI_API_KEY ??
    "";

  return async (prompt: string) => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Judge API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content ?? "";
  };
}

export function resolveJudgeExecutor(config: JudgeConfig): JudgeExecutor {
  if (config.executor) return config.executor;
  return buildFetchExecutor(config);
}

export interface JudgeCriteria {
  criteria: string;
  failWhen: string;
  context?: string;
}

const JUDGE_SYSTEM_PROMPT = `You are an evaluation judge for an AI agent's response. Evaluate the response against the provided criteria.
Return EXACTLY one JSON object with these fields:
- "verdict": one of "pass", "fail", or "partial"
- "reasoning": a brief explanation (1-2 sentences)

Rules:
- "pass": The response fully satisfies the success criteria with no issues.
- "partial": The response partially meets the criteria but has notable gaps or minor issues.
- "fail": The response meets the failure conditions or fundamentally misses the criteria.

Respond with ONLY the JSON object, no other text.`;

function buildJudgePrompt(response: string, criteria: JudgeCriteria): string {
  let prompt = `${JUDGE_SYSTEM_PROMPT}

## Agent Response
${response}

## Success Criteria
${criteria.criteria}

## Failure Conditions
${criteria.failWhen}`;

  if (criteria.context) {
    prompt += `\n\n## Additional Context\n${criteria.context}`;
  }

  return prompt;
}

function parseJudgeResponse(raw: string, criteria: string): JudgeResult {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Judge returned no JSON object: "${raw.slice(0, 200)}"`);
  }

  const parsed = JSON.parse(jsonMatch[0]);

  const verdict = parsed.verdict as string;
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "partial") {
    throw new Error(`Judge returned invalid verdict: "${verdict}"`);
  }

  return {
    verdict: verdict as JudgeVerdict,
    reasoning: String(parsed.reasoning ?? ""),
    criteria,
  };
}

export async function callJudge(
  response: string,
  criteria: JudgeCriteria,
  executor: JudgeExecutor,
): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(response, criteria);

  let raw: string;
  try {
    raw = await executor(prompt);
  } catch (err) {
    throw new Error(`Judge executor failed: ${(err as Error).message}`);
  }

  try {
    return parseJudgeResponse(raw, criteria.criteria);
  } catch (firstErr) {
    // Retry once on parse failure
    try {
      raw = await executor(prompt);
      return parseJudgeResponse(raw, criteria.criteria);
    } catch {
      throw firstErr;
    }
  }
}
