import { createHash } from "crypto";
import type {
  AgentExecutor,
  AgentReport,
  HookFn,
  SceneDefinition,
  SceneResult,
} from "./types";
import { executeScene } from "./runner";
import { resolveText } from "./resolve";
import { formatReport, writeReport, writeDiffEntry } from "./reporter";
import { logger, c } from "./logger";
import { loadConfig } from "./config";
import { setPricingOverrides } from "./pricing";
import { renderTerminalWaterfall } from "./waterfall";
import type { StandardSchemaV1 } from "./schema";
import { PromisePool } from "@supercharge/promise-pool";

/**
 * Builds a scene. Generic over `T`, the agent's native value type, so the
 * known fields hand a typed value to the assertion callback:
 *   - `"value"` / `"response"` → `T`
 *   - `"text"`                 → `string`
 *   - `"refusal"`              → `boolean | undefined`
 *   - any dot-path / other     → `any` (a string field can't be typed)
 * `T` flows in from a schema-typed `agent()` via the scene fn passed to its
 * callback. The free `scene()` import stays `SceneBuilder<string>`.
 */
export class SceneBuilder<T = string> {
  private _assertions: Array<{ field: string; fn: (value: any) => void }> = [];
  private _timeout?: number;
  private _turns?: number;
  private _runs?: number;
  private _suite?: string;
  private _schema?: StandardSchemaV1;

  constructor(private _prompt: string) {}

  timeout(ms: number): this {
    this._timeout = ms;
    return this;
  }

  turns(n: number): this {
    this._turns = n;
    return this;
  }

  runs(n: number): this {
    this._runs = Math.max(1, Math.round(n));
    return this;
  }

  /** @internal */
  _setSuite(name: string): void {
    this._suite = name;
  }

  expect(field: "value" | "response", fn: (value: T) => void): this;
  expect(field: "text", fn: (value: string) => void): this;
  expect(field: "refusal", fn: (value: boolean | undefined) => void): this;
  expect(field: string, fn: (value: any) => void): this;
  expect(field: string, fn: (value: any) => void): this {
    this._assertions.push({ field, fn });
    return this;
  }

  /**
   * Validate this scene's native value against a Standard Schema before user
   * assertions run. Overrides any schema declared on the agent.
   */
  expectSchema(schema: StandardSchemaV1): this {
    this._schema = schema;
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
      schema: this._schema,
    };
  }
}

export class AgentContext<T = string> {
  private _scenes: SceneBuilder<T>[] = [];
  private _currentSuite?: string;

  private _beforeAllHooks: HookFn[] = [];
  private _afterAllHooks: HookFn[] = [];
  private _beforeEachHooks: HookFn[] = [];
  private _afterEachHooks: HookFn[] = [];

  constructor(
    private _executor: AgentExecutor<T>,
    private _name?: string,
    private _schema?: StandardSchemaV1,
  ) {}

  registerHook(type: "beforeAll" | "afterAll" | "beforeEach" | "afterEach", fn: HookFn): void {
    this[`_${type}Hooks`].push(fn);
  }

  setSuite(name: string): void {
    this._currentSuite = name;
  }

  clearSuite(): void {
    this._currentSuite = undefined;
  }

  registerScene(prompt: string): SceneBuilder<T> {
    const builder = new SceneBuilder<T>(prompt);
    if (this._currentSuite) {
      builder._setSuite(this._currentSuite);
    }
    this._scenes.push(builder);
    return builder;
  }

  async execute(): Promise<AgentReport<T>> {
    // `--full` flows in via the CLI runner (AGEST_FULL env) or directly on argv
    // when a test file is run standalone (`tsx foo.test.ts --full`). Default is
    // lean output: per-scene results only, no waterfall, no full report dump.
    const full = process.env.AGEST_FULL === "1" || process.argv.includes("--full");
    const config = await loadConfig();
    setPricingOverrides(config.pricing);
    const parallelism = Math.max(1, config.parallelism ?? 1);
    const definitions = this._scenes.map((s) => {
      const def = s.toDefinition();
      // Agent-level schema is the default; a scene-level schema wins.
      if (!def.schema && this._schema) def.schema = this._schema;
      return def;
    });
    const orderedResults: SceneResult<T>[] = new Array(definitions.length);
    const total = definitions.length;

    // Group scenes by suite for organized output
    const suiteNames = [...new Set(definitions.map((d) => d.suite).filter(Boolean))] as string[];
    const hasSuites = suiteNames.length > 0;
    const suiteCount = hasSuites ? ` (${suiteNames.length} suite${suiteNames.length !== 1 ? "s" : ""})` : "";

    logger.info(c.bold(`\nRunning ${total} scene${total !== 1 ? "s" : ""}${suiteCount}${parallelism > 1 ? c.dim(` (parallelism: ${parallelism})`) : ""}...\n`));

    // Run beforeAll hooks
    for (const hook of this._beforeAllHooks) {
      await hook();
    }

    const buildTask = (scene: SceneDefinition, i: number) => async () => {
      const label = scene.prompt.length > 60
        ? scene.prompt.slice(0, 57) + "..."
        : scene.prompt;

      // Run beforeEach hooks
      for (const hook of this._beforeEachHooks) {
        await hook();
      }

      const result = await executeScene(this._executor, scene, config.timeout, config.judge, config.turns, config.runs);
      orderedResults[i] = result;

      // Run afterEach hooks
      for (const hook of this._afterEachHooks) {
        await hook();
      }

      const ms = result.duration.toFixed(0);
      const runsLabel = result.runs ? c.dim(` [${result.runs.filter(r => r.passed).length}/${result.runs.length} passed]`) : "";
      const indent = hasSuites ? "    " : "  ";

      if (result.passed) {
        logger.info(`${indent}${c.cyan(`[${i + 1}/${total}]`)} ${label} ... ${c.green("PASS")}${c.dim(` (${ms}ms)`)}${runsLabel}`);
      } else if (result.judgement?.verdict === "partial") {
        logger.info(`${indent}${c.cyan(`[${i + 1}/${total}]`)} ${label} ... ${c.yellow("PARTIAL")}${c.dim(` (${ms}ms)`)}${runsLabel}`);
        if (result.error) {
          logger.info(`${indent}       ${c.yellow(result.error)}`);
        }
      } else {
        logger.info(`${indent}${c.cyan(`[${i + 1}/${total}]`)} ${label} ... ${c.red("FAIL")}${c.dim(` (${ms}ms)`)}${runsLabel}`);
        if (result.error) {
          logger.info(`${indent}       ${c.red(result.error)}`);
        }
      }

      if (result.statisticalSignificance != null) {
        const sig = result.statisticalSignificance;
        const sigColor = sig >= 0.95 ? c.green : sig >= 0.80 ? c.yellow : c.red;
        logger.info(`${indent}       ${c.dim("significance:")} ${sigColor(`${(sig * 100).toFixed(1)}%`)} ${c.dim(`(pass rate: ${((result.passRate ?? 0) * 100).toFixed(1)}%)`)}`);
      }

      if (full && result.events && result.events.length > 0) {
        const costLabel = result.costUsd != null
          ? ` ${c.dim("·")} ${c.green(`$${Number(result.costUsd.toFixed(4))}`)}`
          : "";
        const tokLabel = result.tokens
          ? ` ${c.dim(`(${result.tokens.input}→${result.tokens.output} tok)`)}`
          : "";
        logger.info(`${indent}       ${c.dim("waterfall:")}${tokLabel}${costLabel}`);
        for (const line of renderTerminalWaterfall(result.events, { indent: `${indent}       ` })) {
          logger.info(line);
        }
      }

      logger.debug(`${indent}       response: ${resolveText(result.response).slice(0, 120)}`);
    };

    if (hasSuites) {
      // Execute suite by suite — print header once, then run all scenes in that suite
      for (const suiteName of suiteNames) {
        const suiteIndices = definitions
          .map((d, i) => d.suite === suiteName ? i : -1)
          .filter((i) => i !== -1);

        logger.info(`  ${c.bold(c.cyan(`▸ ${suiteName}`))} ${c.dim(`(${suiteIndices.length} scene${suiteIndices.length !== 1 ? "s" : ""})`)}`);

        const tasks = suiteIndices.map((i) => buildTask(definitions[i], i));
        await PromisePool.withConcurrency(parallelism).for(tasks).process((task) => task());
        logger.info("");
      }

      // Run any scenes not in a suite
      const unsuitedIndices = definitions
        .map((d, i) => d.suite ? -1 : i)
        .filter((i) => i !== -1);
      if (unsuitedIndices.length > 0) {
        const tasks = unsuitedIndices.map((i) => buildTask(definitions[i], i));
        await PromisePool.withConcurrency(parallelism).for(tasks).process((task) => task());
      }
    } else {
      const tasks = definitions.map((scene, i) => buildTask(scene, i));
      await PromisePool.withConcurrency(parallelism).for(tasks).process((task) => task());
    }

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

    const sceneTokens = results
      .map((r) => r.tokens ?? r.response.metadata?.tokens)
      .filter((t): t is { input: number; output: number } => t != null);

    let averageInputTokensPerCase: number | undefined;
    let averageOutputTokensPerCase: number | undefined;
    let totalInputTokens: number | undefined;
    let totalOutputTokens: number | undefined;

    if (sceneTokens.length > 0) {
      totalInputTokens = sceneTokens.reduce((s, t) => s + (t.input ?? 0), 0);
      totalOutputTokens = sceneTokens.reduce((s, t) => s + (t.output ?? 0), 0);
      averageInputTokensPerCase = Math.round(totalInputTokens / sceneTokens.length);
      averageOutputTokensPerCase = Math.round(totalOutputTokens / sceneTokens.length);
    }

    const sceneCosts = results
      .map((r) => r.costUsd)
      .filter((c): c is number => typeof c === "number");
    const totalCostUsd = sceneCosts.length > 0
      ? sceneCosts.reduce((s, c) => s + c, 0)
      : undefined;

    const firstMeta = results.find((r) => r.response.metadata)?.response
      .metadata;

    const dimensions: Record<string, string> = {};
    if (firstMeta?.model) dimensions.model = firstMeta.model;
    if (firstMeta?.systemPrompt) dimensions.prompt = hashPromptOnly(firstMeta.systemPrompt);
    if (firstMeta?.tools?.length) dimensions.tools = [...firstMeta.tools].sort().join(",");
    else dimensions.tools = "none";

    const report: AgentReport<T> = {
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
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd,
      results,
    };

    if (report.systemPromptHash && firstMeta?.systemPrompt) {
      await writeDiffEntry(report.systemPromptHash, firstMeta.systemPrompt, report.tools ?? [], report.model);
    }

    const formatted = formatReport(report);

    // Default mode prints a one-line summary; `--full` dumps the whole report.
    if (full) {
      logger.info(formatted);
    } else {
      const passed = results.filter((r) => r.passed).length;
      const rateColor = successRate >= 0.95 ? c.green : successRate >= 0.5 ? c.yellow : c.red;
      const costSummary = totalCostUsd != null ? ` ${c.dim("·")} ${c.green(`$${Number(totalCostUsd.toFixed(4))}`)}` : "";
      logger.info(
        `${rateColor(`${passed}/${results.length} passed`)} ${c.dim(`(${(successRate * 100).toFixed(0)}%)`)} ${c.dim("·")} ${c.dim(`${Math.round(totalDuration)}ms`)}${costSummary}`,
      );
    }

    const filepath = await writeReport(formatted, report.timestamp, report.name, report.dimensions);
    logger.info(`${c.dim("Report saved to:")} ${c.cyan(filepath)}${full ? "" : c.dim(" (run with --full to print it)")}`);

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


// The active context is a runtime singleton holding an executor of arbitrary
// value type, so `any` is the honest type for the holder. The generic flows
// through `agent()` → `AgentContext<T>` → the report at the call site.
let currentContext: AgentContext<any> | null = null;

export function setContext(ctx: AgentContext<any> | null): void {
  currentContext = ctx;
}

export function getContext(): AgentContext<any> {
  if (!currentContext) {
    throw new Error("scene() must be called inside an agent() callback");
  }
  return currentContext;
}
