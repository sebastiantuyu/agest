import { describe, it, expect } from "vitest";
import { renderTerminalWaterfall } from "./waterfall.js";
import { parseScenes } from "./reports.js";
import type { TimelineEvent } from "./types.js";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const sample: TimelineEvent[] = [
  { kind: "model", name: "openai/gpt-5.4", startMs: 10, endMs: 2841, durationMs: 2831, tokens: { input: 2212, output: 161 }, cost: { totalUsd: 0.004375, source: "table" } },
  { kind: "tool", name: "DynamicStructuredTool", startMs: 2844, endMs: 2844, durationMs: 0 },
  { kind: "model", name: "openai/gpt-5.4", startMs: 2847, endMs: 4733, durationMs: 1886, tokens: { input: 3087, output: 84 }, cost: { totalUsd: 0.004699, source: "table" } },
];

describe("renderTerminalWaterfall", () => {
  it("returns one row per event with label, duration, and cost", () => {
    const lines = renderTerminalWaterfall(sample).map(stripAnsi);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("model");
    expect(lines[0]).toContain("openai/gpt-5.4");
    expect(lines[0]).toContain("2831ms");
    expect(lines[0]).toContain("$0.0044");
    expect(lines[1]).toContain("tool");
    expect(lines[1]).toContain("0ms");
  });

  it("positions later events further right than earlier ones", () => {
    const lines = renderTerminalWaterfall(sample).map(stripAnsi);
    const firstBlockAt = lines[0].indexOf("█");
    const lastBlockAt = lines[2].indexOf("█");
    expect(lastBlockAt).toBeGreaterThan(firstBlockAt);
  });

  it("returns [] for no events", () => {
    expect(renderTerminalWaterfall([])).toEqual([]);
  });
});

describe("parseScenes (round-trip from report YAML)", () => {
  const yaml = [
    "agent:",
    '    name: "x"',
    "    total_cost_usd: 0.009074",
    "    scenes:",
    '        - prompt: "maria-cena-only"',
    "          duration_ms: 15695",
    "          tokens: { input: 5299, output: 245 }",
    "          cost_usd: 0.009074",
    "          cost_source: table",
    "          timeline:",
    "              - kind: model",
    '                name: "openai/gpt-5.4"',
    "                start_ms: 10",
    "                duration_ms: 2831",
    "                tokens: { input: 2212, output: 161 }",
    "                cost_usd: 0.004375",
    "                cost_source: table",
    "              - kind: tool",
    '                name: "DynamicStructuredTool"',
    "                start_ms: 2844",
    "                duration_ms: 0",
  ].join("\n");

  it("parses scene meta and timeline events", () => {
    const scenes = parseScenes(yaml);
    expect(scenes).toHaveLength(1);
    const s = scenes![0];
    expect(s.prompt).toBe("maria-cena-only");
    expect(s.durationMs).toBe(15695);
    expect(s.tokens).toEqual({ input: 5299, output: 245 });
    expect(s.costUsd).toBeCloseTo(0.009074);
    expect(s.costSource).toBe("table");
    expect(s.timeline).toHaveLength(2);
    expect(s.timeline![0]).toMatchObject({
      kind: "model",
      name: "openai/gpt-5.4",
      startMs: 10,
      durationMs: 2831,
      tokens: { input: 2212, output: 161 },
      costUsd: 0.004375,
    });
    expect(s.timeline![1]).toMatchObject({ kind: "tool", name: "DynamicStructuredTool", durationMs: 0 });
  });

  it("returns undefined when there is no scenes block", () => {
    expect(parseScenes("agent:\n    name: \"x\"\n")).toBeUndefined();
  });
});
