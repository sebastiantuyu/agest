import { createHash } from "crypto";
import type {
  AgentExecutor,
  AgentReport,
  HookFn,
  SceneDefinition,
  SceneResult,
} from "./types";
import { executeScene } from "./runner";
import { formatReport, writeReport, writeDiffEntry } from "./reporter";
import { logger, c } from "./logger";
import { loadConfig } from "./config";
import { PromisePool } from "@supercharge/promise-pool";

export class SceneBuilder {
  private _assertions: Array<{ field: string; fn: (value: any) => void }> = [];
  private _timeout?: number;
  private _turns?: number;
  private _runs?: number;
  private _suite?: string;

  constructor(private _prompt: string) {}

  timeout(ms: number): SceneBuilder {
    this._timeout = ms;
    return this;
  }

  turns(n: number): SceneBuilder {
    this._turns = n;
    return this;
  }

  runs(n: number): SceneBuilder {
    this._runs = Math.max(1, Math.round(n));
    return this;
  }

  /** @internal */
  _setSuite(name: string): void {
    this._suite = name;
  }

  expect(field: string, fn: (value: any) => void): SceneBuilder {
    this._assertions.push({ field, fn });
    return this;
  }

  toDefinition(): SceneDefinition {
    return {
      prompt: this._prompt,
      assertions: [...this._assertions],
      timeout: this._timeout,
      turns: this._turns,
      runs: this._runs,
      suite: this._suite,
    };
  }
}

export class AgentContext {
  private _scenes: SceneBuilder[] = [];
  private _currentSuite?: string;

  private _beforeAllHooks: HookFn[] = [];
  private _afterAllHooks: HookFn[] = [];
  private _beforeEachHooks: HookFn[] = [];
  private _afterEachHooks: HookFn[] = [];

  constructor(private _executor: AgentExecutor, private _name?: string) {}

  registerHook(type: "beforeAll" | "afterAll" | "beforeEach" | "afterEach", fn: HookFn): void {
    this[`_${type}Hooks`].push(fn);
  }

  setSuite(name: string): void {
    this._currentSuite = name;
  }

  clearSuite(): void {
    this._currentSuite = undefined;
  }

  registerScene(prompt: string): SceneBuilder {
    const builder = new SceneBuilder(prompt);
    if (this._currentSuite) {
      builder._setSuite(this._currentSuite);
    }
    this._scenes.push(builder);
    return builder;
  }

  async execute(): Promise<AgentReport> {
    const config = await loadConfig();
    const parallelism = Math.max(1, config.parallelism ?? 1);
    const definitions = this._scenes.map((s) => s.toDefinition());
    const orderedResults: SceneResult[] = new Array(definitions.length);
    const total = definitions.length;

    logger.info(c.bold(`\nRunning ${total} scene${total !== 1 ? "s" : ""}${parallelism > 1 ? c.dim(` (parallelism: ${parallelism})`) : ""}...\n`));

    // Run beforeAll hooks
    for (const hook of this._beforeAllHooks) {
      await hook();
    }

    let lastSuite: string | undefined;

    const tasks = definitions.map((scene, i) => async () => {
      // Print suite header when entering a new suite
      if (scene.suite !== lastSuite) {
        lastSuite = scene.suite;
        if (scene.suite) {
          logger.info(`\n  ${c.bold(c.cyan(`▸ ${scene.suite}`))}`);
        }
      }

      const label = scene.prompt.length > 60
        ? scene.prompt.slice(0, 57) + "..."
        : scene.prompt;

      // Run beforeEach hooks
      for (const hook of this._beforeEachHooks) {
        await hook();
      }

      const result = await executeScene(this._executor, scene, config.timeout, config.judge, config.turns);
      orderedResults[i] = result;

      // Run afterEach hooks
      for (const hook of this._afterEachHooks) {
        await hook();
      }

      const ms = result.duration.toFixed(0);
      const runsLabel = result.runs ? c.dim(` [${result.runs.filter(r => r.passed).length}/${result.runs.length} passed]`) : "";

      if (result.passed) {
        logger.info(`  ${c.cyan(`[${i + 1}/${total}]`)} ${label} ... ${c.green("PASS")}${c.dim(` (${ms}ms)`)}${runsLabel}`);
      } else if (result.judgement?.verdict === "partial") {
        logger.info(`  ${c.cyan(`[${i + 1}/${total}]`)} ${label} ... ${c.yellow("PARTIAL")}${c.dim(` (${ms}ms)`)}${runsLabel}`);
        if (result.error) {
          logger.info(`         ${c.yellow(result.error)}`);
        }
      } else {
        logger.info(`  ${c.cyan(`[${i + 1}/${total}]`)} ${label} ... ${c.red("FAIL")}${c.dim(` (${ms}ms)`)}${runsLabel}`);
        if (result.error) {
          logger.info(`         ${c.red(result.error)}`);
        }
      }

      if (result.statisticalSignificance != null) {
        const sig = result.statisticalSignificance;
        const sigColor = sig >= 0.95 ? c.green : sig >= 0.80 ? c.yellow : c.red;
        logger.info(`         ${c.dim("significance:")} ${sigColor(`${(sig * 100).toFixed(1)}%`)} ${c.dim(`(pass rate: ${((result.passRate ?? 0) * 100).toFixed(1)}%)`)}`);
      }

      logger.debug(`         response: ${result.response.text?.slice(0, 120)}`);
    });

    await PromisePool.withConcurrency(parallelism).for(tasks).process((task) => task());

    // Run afterAll hooks
    for (const hook of this._afterAllHooks) {
      await hook();
    }

    const results = orderedResults;
    let totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

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

    const dimensions: Record<string, string> = {};
    if (firstMeta?.model) dimensions.model = firstMeta.model;
    if (firstMeta?.systemPrompt) dimensions.prompt = hashPromptOnly(firstMeta.systemPrompt);
    if (firstMeta?.tools?.length) dimensions.tools = [...firstMeta.tools].sort().join(",");
    else dimensions.tools = "none";

    const report: AgentReport = {
      name: this._name,
      model: firstMeta?.model,
      systemPromptHash: firstMeta?.systemPrompt
        ? hashPrompt(firstMeta.systemPrompt, firstMeta.model)
        : undefined,
      promptHash: firstMeta?.systemPrompt
        ? hashPromptOnly(firstMeta.systemPrompt)
        : undefined,
      dimensions,
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

    if (report.systemPromptHash && firstMeta?.systemPrompt) {
      await writeDiffEntry(report.systemPromptHash, firstMeta.systemPrompt, report.tools ?? [], report.model);
    }

    const formatted = formatReport(report);
    logger.info(formatted);

    const filepath = await writeReport(formatted, report.timestamp, report.name, report.dimensions);
    logger.info(`\n${c.dim("Report saved to:")} ${c.cyan(filepath)}`);

    return report;
  }
}

function hashPrompt(prompt: string, model?: string): string {
  const input = model ? `${model}:${prompt}` : prompt;
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

export function hashPromptOnly(prompt: string): string {
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
