import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

export interface ModelPrice {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
}

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
  /** USD cost the provider already reported (takes precedence) */
  providerCost?: number;
}

export function computeCost(input: ComputeCostInput): CostBreakdown {
  if (input.providerCost != null && Number.isFinite(input.providerCost)) {
    return { totalUsd: input.providerCost, source: "provider" };
  }

  const price = lookupPrice(input.model);
  if (!price) return { source: "unavailable" };

  const inputUsd = ((input.inputTokens ?? 0) / 1_000_000) * price.input;
  const outputUsd = ((input.outputTokens ?? 0) / 1_000_000) * price.output;
  return {
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + outputUsd,
    source: "table",
  };
}
