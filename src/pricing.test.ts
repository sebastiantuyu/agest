import { describe, it, expect, beforeEach } from "vitest";
import { computeCost, lookupPrice, setPricingOverrides } from "./pricing";

describe("lookupPrice", () => {
  beforeEach(() => setPricingOverrides(undefined));

  it("returns built-in entry for a known model", () => {
    const price = lookupPrice("gpt-4o");
    expect(price).toEqual({ input: 2.5, output: 10 });
  });

  it("returns undefined for an unknown model", () => {
    expect(lookupPrice("totally-fake-model")).toBeUndefined();
  });

  it("falls back to a loose match when prefix/suffix overlaps", () => {
    // OpenRouter usually prefixes the canonical name, e.g. "openai/gpt-4o"
    expect(lookupPrice("openai/gpt-4o")).toEqual({ input: 2.5, output: 10 });
  });

  it("returns undefined for empty model", () => {
    expect(lookupPrice(undefined)).toBeUndefined();
  });

  it("honors overrides ahead of built-ins", () => {
    setPricingOverrides({ "gpt-4o": { input: 99, output: 99 } });
    expect(lookupPrice("gpt-4o")).toEqual({ input: 99, output: 99 });
  });

  it("can introduce a brand new model via overrides", () => {
    setPricingOverrides({ "my-internal-model": { input: 1, output: 2 } });
    expect(lookupPrice("my-internal-model")).toEqual({ input: 1, output: 2 });
  });
});

describe("computeCost", () => {
  beforeEach(() => setPricingOverrides(undefined));

  it("prefers provider cost when present", () => {
    const c = computeCost({ model: "gpt-4o", inputTokens: 1000, outputTokens: 500, providerCost: 0.42 });
    expect(c).toEqual({ totalUsd: 0.42, source: "provider" });
  });

  it("computes from the table when no provider cost is given", () => {
    const c = computeCost({ model: "gpt-4o", inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(c.source).toBe("table");
    expect(c.inputUsd).toBeCloseTo(2.5);
    expect(c.outputUsd).toBeCloseTo(10);
    expect(c.totalUsd).toBeCloseTo(12.5);
  });

  it("returns 'unavailable' when the model is unknown", () => {
    const c = computeCost({ model: "totally-fake-model", inputTokens: 1000, outputTokens: 500 });
    expect(c).toEqual({ source: "unavailable" });
  });

  it("handles missing token counts as zero", () => {
    const c = computeCost({ model: "gpt-4o" });
    expect(c.totalUsd).toBe(0);
    expect(c.source).toBe("table");
  });
});
