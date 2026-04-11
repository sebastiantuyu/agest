import { createHash } from "crypto";
import type {
  AgentExecutor,
  AgentReport,
  SceneDefinition,
  SceneResult,
} from "./types";
import { executeScene } from "./runner";
import { formatReport, writeReport } from "./reporter";
import { logger, c } from "./logger";

export class SceneBuilder {
  private _assertions: Array<{ field: string; fn: (value: any) => void }> = [];

  constructor(private _prompt: string) {}

  expect(field: string, fn: (value: any) => void): SceneBuilder {
    this._assertions.push({ field, fn });
    return this;
  }

  toDefinition(): SceneDefinition {
    return { prompt: this._prompt, assertions: [...this._assertions] };
  }
}

export class AgentContext {
  private _scenes: SceneBuilder[] = [];

  constructor(private _executor: AgentExecutor) {}

  registerScene(prompt: string): SceneBuilder {
    const builder = new SceneBuilder(prompt);
    this._scenes.push(builder);
    return builder;
  }

  async execute(): Promise<AgentReport> {
    const definitions = this._scenes.map((s) => s.toDefinition());
    const results: SceneResult[] = [];
    let totalDuration = 0;
    const total = definitions.length;

    logger.info(c.bold(`\nRunning ${total} scene${total !== 1 ? "s" : ""}...\n`));

    for (let i = 0; i < definitions.length; i++) {
      const scene = definitions[i];
      const label = scene.prompt.length > 60
        ? scene.prompt.slice(0, 57) + "..."
        : scene.prompt;
      logger.write(`  ${c.cyan(`[${i + 1}/${total}]`)} ${label} ... `);

      const result = await executeScene(this._executor, scene);
      results.push(result);
      totalDuration += result.duration;

      const ms = result.duration.toFixed(0);
      if (result.passed) {
        logger.info(c.green(`PASS`) + c.dim(` (${ms}ms)`));
      } else {
        logger.info(c.red(`FAIL`) + c.dim(` (${ms}ms)`));
        if (result.error) {
          logger.info(`         ${c.red(result.error)}`);
        }
      }
      logger.debug(`         response: ${result.response.text?.slice(0, 120)}`);
    }

    logger.info("");

    const failedResults = results.filter((r) => !r.passed);
    const failedCases = failedResults.map((r) => r.prompt);
    const failedCaseErrors: Record<string, string> = {};
    for (const r of failedResults) {
      if (r.error) failedCaseErrors[r.prompt] = r.error;
    }

    const successRate =
      results.length > 0
        ? Number(
            (
              results.filter((r) => r.passed).length / results.length
            ).toFixed(2)
          )
        : 0;

    const tokensAvailable = results.some(
      (r) => r.response.metadata?.tokens != null
    );

    let averageInputTokensPerCase: number | undefined;
    let averageOutputTokensPerCase: number | undefined;

    if (tokensAvailable) {
      const withTokens = results.filter(
        (r) => r.response.metadata?.tokens != null
      );
      averageInputTokensPerCase = Math.round(
        withTokens.reduce(
          (sum, r) => sum + (r.response.metadata!.tokens!.input ?? 0),
          0
        ) / withTokens.length
      );
      averageOutputTokensPerCase = Math.round(
        withTokens.reduce(
          (sum, r) => sum + (r.response.metadata!.tokens!.output ?? 0),
          0
        ) / withTokens.length
      );
    }

    const firstMeta = results.find((r) => r.response.metadata)?.response
      .metadata;

    const report: AgentReport = {
      model: firstMeta?.model,
      systemPromptHash: firstMeta?.systemPrompt
        ? hashPrompt(firstMeta.systemPrompt)
        : undefined,
      tools: firstMeta?.tools,
      successRate,
      failedCases,
      failedCaseErrors,
      timestamp: new Date().toISOString(),
      duration: Math.round(totalDuration),
      totalCases: results.length,
      averageInputTokensPerCase,
      averageOutputTokensPerCase,
      results,
    };

    const formatted = formatReport(report);
    logger.info(formatted);

    const filepath = await writeReport(formatted, report.timestamp);
    logger.info(`\n${c.dim("Report saved to:")} ${c.cyan(filepath)}`);

    return report;
  }
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 12);
}

let currentContext: AgentContext | null = null;

export function setContext(ctx: AgentContext | null): void {
  currentContext = ctx;
}

export function getContext(): AgentContext {
  if (!currentContext) {
    throw new Error("scene() must be called inside an agent() callback");
  }
  return currentContext;
}
