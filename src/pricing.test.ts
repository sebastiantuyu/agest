import { describe, it, expect, beforeEach } from "vitest";
import { computeCost, lookupPrice, setPricingOverrides } from "./pricing/index.js";

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

  it("bills cached input tokens at the default 0.1x multiplier", () => {
    const c = computeCost({ model: "gpt-4o", inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 800_000 });
    // 200k uncached @2.5 + 800k cached @0.25 (=2.5*0.1)
    expect(c.inputUsd).toBeCloseTo((200_000 / 1e6) * 2.5 + (800_000 / 1e6) * 0.25);
    expect(c.source).toBe("table");
  });

  it("honors an explicit cachedInput rate from overrides", () => {
    setPricingOverrides({ "gpt-5.4": { input: 3, output: 15, cachedInput: 0.3 } });
    const c = computeCost({ model: "gpt-5.4", inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 });
    expect(c.inputUsd).toBeCloseTo(0.3); // all cached @0.3/MTok
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
