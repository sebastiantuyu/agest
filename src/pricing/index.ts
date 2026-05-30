import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

export interface ModelPrice {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /**
   * USD per 1M cached (prompt-cache-hit) input tokens. When omitted, cached
   * tokens are billed at `DEFAULT_CACHE_MULTIPLIER` × the input rate.
   */
  cachedInput?: number;
}

/** Fraction of the input rate charged for cache-hit tokens when no explicit rate is set. */
export const DEFAULT_CACHE_MULTIPLIER = 0.1;

export type CostSource = "provider" | "table" | "unavailable";

export interface CostBreakdown {
  inputUsd?: number;
  outputUsd?: number;
  totalUsd?: number;
  source: CostSource;
}

const here = dirname(fileURLToPath(import.meta.url));
const builtIn: Record<string, ModelPrice> = JSON.parse(
  readFileSync(join(here, "models.json"), "utf-8")
);

let overrides: Record<string, ModelPrice> = {};

export function setPricingOverrides(table?: Record<string, ModelPrice>): void {
  overrides = table ?? {};
}

export function lookupPrice(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  if (overrides[model]) return overrides[model];
  if (builtIn[model]) return builtIn[model];

  // Loose suffix/prefix match — pick the longest matching key
  const lowered = model.toLowerCase();
  const keys = Object.keys({ ...builtIn, ...overrides })
    .filter((k) => lowered.includes(k.toLowerCase()) || k.toLowerCase().includes(lowered))
    .sort((a, b) => b.length - a.length);

  if (keys.length > 0) {
    return overrides[keys[0]] ?? builtIn[keys[0]];
  }
  return undefined;
}

export interface ComputeCostInput {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Cache-hit input tokens (subset of inputTokens), billed at the cached rate. */
  cachedInputTokens?: number;
  /** USD cost the provider already reported (takes precedence) */
  providerCost?: number;
}

export function computeCost(input: ComputeCostInput): CostBreakdown {
  if (input.providerCost != null && Number.isFinite(input.providerCost)) {
    return { totalUsd: input.providerCost, source: "provider" };
  }

  const price = lookupPrice(input.model);
  if (!price) return { source: "unavailable" };

  const totalInput = input.inputTokens ?? 0;
  const cached = Math.min(input.cachedInputTokens ?? 0, totalInput);
  const uncached = totalInput - cached;
  const cachedRate = price.cachedInput ?? price.input * DEFAULT_CACHE_MULTIPLIER;

  const inputUsd =
    (uncached / 1_000_000) * price.input + (cached / 1_000_000) * cachedRate;
  const outputUsd = ((input.outputTokens ?? 0) / 1_000_000) * price.output;
  return {
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + outputUsd,
    source: "table",
  };
}
