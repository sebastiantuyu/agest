import { describe, it, expect } from "vitest";
import { CATALOG, PRESETS, resolveAreas, computeAreaCoverage } from "./areas.js";
import type { SceneResult } from "./types.js";

function scene(partial: Partial<SceneResult>): SceneResult {
  return {
    prompt: partial.prompt ?? "p",
    response: { text: "r" },
    duration: 1,
    passed: partial.passed ?? true,
    ...partial,
  } as SceneResult;
}

describe("resolveAreas", () => {
  it("unions an extends preset, pulling minScenes from the catalog", () => {
    const { optedIn } = resolveAreas({ extends: ["agest/recommended"] });
    expect([...optedIn.keys()].sort()).toEqual(Object.keys(CATALOG).sort());
    expect(optedIn.get("refusal")?.minScenes).toBe(CATALOG.refusal.minScenes);
  });

  it("throws on an unknown preset id (typo protection)", () => {
    expect(() => resolveAreas({ extends: ["typo/preset"] })).toThrow(/Unknown areas preset/);
  });

  it("include adds a bare id and an { id, minScenes } override", () => {
    const { optedIn } = resolveAreas({
      include: ["billing", { id: "refusal", minScenes: 99 }],
    });
    expect(optedIn.has("billing")).toBe(true);
    expect(optedIn.get("billing")?.minScenes).toBeUndefined(); // open domain tag, no default
    expect(optedIn.get("refusal")?.minScenes).toBe(99); // override beats catalog default
  });

  it("exclude drops an area from the opted-in set", () => {
    const { optedIn } = resolveAreas({
      extends: ["agest/recommended"],
      exclude: ["memory"],
    });
    expect(optedIn.has("memory")).toBe(false);
  });

  it("returns an empty set for an empty/undefined config", () => {
    expect(resolveAreas().optedIn.size).toBe(0);
    expect(resolveAreas({}).optedIn.size).toBe(0);
  });

  it("recommended preset covers all catalog areas", () => {
    expect(PRESETS["agest/recommended"]).toEqual(Object.keys(CATALOG));
  });
});

describe("computeAreaCoverage", () => {
  it("tallies distinct scenes and pass counts per tag", () => {
    const results = [
      scene({ tags: ["refusal"], passed: true }),
      scene({ tags: ["refusal"], passed: false }),
      scene({ tags: ["tool-use"], passed: true }),
    ];
    const { optedIn } = resolveAreas({ include: ["refusal", "tool-use"] });
    const { areaCoverage } = computeAreaCoverage(results, optedIn);
    const refusal = areaCoverage.find((a) => a.id === "refusal")!;
    expect(refusal.scenes).toBe(2);
    expect(refusal.passed).toBe(1);
    expect(refusal.passRate).toBe(0.5);
  });

  it("counts trials from .runs (scene×runs) for the Wilson basis", () => {
    const results = [
      scene({
        tags: ["robustness"],
        passed: true,
        runs: [
          { passed: true, response: { text: "r" }, duration: 1 },
          { passed: false, response: { text: "r" }, duration: 1 },
          { passed: true, response: { text: "r" }, duration: 1 },
        ],
      }),
    ];
    const { areaCoverage } = computeAreaCoverage(results, new Map());
    const a = areaCoverage.find((x) => x.id === "robustness")!;
    expect(a.scenes).toBe(1);
    expect(a.trials).toBe(3);
    expect(a.trialPasses).toBe(2);
  });

  it("surfaces opted-in-but-unobserved areas as scenes: 0 (the missing signal)", () => {
    const results = [scene({ tags: ["refusal"] })];
    const { optedIn } = resolveAreas({ include: ["refusal", "memory"] });
    const { areaCoverage } = computeAreaCoverage(results, optedIn);
    const memory = areaCoverage.find((a) => a.id === "memory")!;
    expect(memory.scenes).toBe(0);
    expect(memory.passRate).toBe(0);
  });

  it("marks non-catalog tags as domain tags (inCatalog: false)", () => {
    const results = [scene({ tags: ["billing"] })];
    const { areaCoverage } = computeAreaCoverage(results, new Map());
    expect(areaCoverage.find((a) => a.id === "billing")!.inCatalog).toBe(false);
    expect(areaCoverage.find((a) => a.id === "refusal")).toBeUndefined();
  });

  it("partitions the breakdown by suite", () => {
    const results = [
      scene({ tags: ["refusal"], suite: "checkout" }),
      scene({ tags: ["tool-use"], suite: "search" }),
      scene({ tags: ["refusal"] }), // no suite
    ];
    const { areaCoverageBySuite } = computeAreaCoverage(results, new Map());
    const suites = areaCoverageBySuite.map((s) => s.suite).sort();
    expect(suites).toEqual(["(no suite)", "checkout", "search"]);
    const checkout = areaCoverageBySuite.find((s) => s.suite === "checkout")!;
    expect(checkout.areas.map((a) => a.id)).toEqual(["refusal"]);
  });

  it("counts untagged scenes", () => {
    const results = [
      scene({ tags: ["refusal"] }),
      scene({}), // untagged
      scene({ tags: [] }), // untagged
    ];
    const { untaggedCount } = computeAreaCoverage(results, new Map());
    expect(untaggedCount).toBe(2);
  });
});
