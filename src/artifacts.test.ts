import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentReport, SceneResult } from "./types.js";
import {
  buildCaseArtifact,
  slugCase,
  renderFailuresMarkdown,
  gitInfo,
  agestVersion,
  writeRunArtifacts,
  finalizeSweep,
} from "./artifacts.js";

const passingScene: SceneResult<{ a: number }> = {
  prompt: "pick a plan",
  suite: "selection",
  response: { value: { a: 1 }, text: "rendered plan" },
  duration: 12.7,
  passed: true,
  assertions: [{ field: "value", passed: true }],
  tokens: { input: 10, output: 5 },
  costUsd: 0.002,
};

const failingScene: SceneResult<{ a: number }> = {
  prompt: "maria cena only",
  suite: "selection",
  response: { value: { a: 2 } },
  duration: 5,
  passed: false,
  error: "expected 1",
  assertions: [
    { field: "slots.cena.options", passed: false, message: "an option isn't appropriate", actualValue: "[\"leche\"]" },
  ],
};

describe("buildCaseArtifact", () => {
  it("captures the resolved structured value and text for a passing scene", () => {
    const a = buildCaseArtifact(passingScene);
    expect(a.passed).toBe(true);
    expect(a.resolvedValue).toEqual({ a: 1 }); // raw object, not stringified
    expect(a.text).toBe("rendered plan");
    expect(a.durationMs).toBe(13); // rounded
    expect(a.assertions).toEqual([{ field: "value", passed: true }]);
    expect(a.tokens).toEqual({ input: 10, output: 5 });
  });

  it("carries the failing assertion detail for a red scene", () => {
    const a = buildCaseArtifact(failingScene);
    expect(a.passed).toBe(false);
    expect(a.error).toBe("expected 1");
    expect(a.assertions[0]).toMatchObject({
      field: "slots.cena.options",
      passed: false,
      message: "an option isn't appropriate",
    });
    expect(a.resolvedValue).toEqual({ a: 2 });
  });

  it("falls back to text when there is no native value", () => {
    const a = buildCaseArtifact({ prompt: "p", response: { text: "hi" }, duration: 1, passed: true });
    expect(a.resolvedValue).toBe("hi");
    expect(a.text).toBe("hi");
  });

  it("includes a runBreakdown only for multi-run scenes", () => {
    const single = buildCaseArtifact(passingScene);
    expect(single.runBreakdown).toBeUndefined();

    const multi = buildCaseArtifact({
      ...failingScene,
      passRate: 0.33,
      statisticalSignificance: 0.1,
      runs: [
        { passed: false, response: { text: "" }, duration: 1, error: "x" },
        { passed: true, response: { text: "" }, duration: 1 },
        { passed: false, response: { text: "" }, duration: 1, error: "y" },
      ],
    });
    expect(multi.runBreakdown).toEqual([
      { index: 0, passed: false, error: "x" },
      { index: 1, passed: true, error: undefined },
      { index: 2, passed: false, error: "y" },
    ]);
    expect(multi.passRate).toBe(0.33);
    expect(multi.significance).toBe(0.1);
  });
});

describe("slugCase", () => {
  it("is filesystem-safe and stable for the same input", () => {
    const a = slugCase("selection", "maria cena only");
    const b = slugCase("selection", "maria cena only");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-z0-9-]+$/);
    expect(a.startsWith("selection-maria-cena-only-")).toBe(true);
  });

  it("disambiguates two prompts that share an 80-char prefix via the hash suffix", () => {
    const prefix = "a".repeat(100);
    const x = slugCase(undefined, prefix + "X");
    const y = slugCase(undefined, prefix + "Y");
    expect(x).not.toBe(y); // differ only past char 80 → the hash saves us
  });

  it("never produces an empty name when the prompt has no alphanumerics", () => {
    const s = slugCase(undefined, "!!!");
    expect(s).toMatch(/^case-[0-9a-f]{8}$/);
  });
});

describe("renderFailuresMarkdown", () => {
  it("includes only red cases with their failing checks and resolved value", () => {
    const md = renderFailuresMarkdown([buildCaseArtifact(failingScene)], "diet-agent");
    expect(md).toContain("# Failures — diet-agent");
    expect(md).toContain("1 failing case");
    expect(md).toContain("maria cena only");
    expect(md).toContain("`slots.cena.options`");
    expect(md).toContain("an option isn't appropriate");
    expect(md).toContain("Resolved value");
    // No passing case should ever appear.
    expect(md).not.toContain("pick a plan");
  });
});

describe("provenance helpers", () => {
  it("gitInfo returns a dirty boolean and never throws", () => {
    const info = gitInfo();
    expect(typeof info.dirty).toBe("boolean");
  });

  it("agestVersion reads this package's version", () => {
    expect(agestVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("writeRunArtifacts + finalizeSweep (I/O round-trip)", () => {
  const makeReport = (results: SceneResult<any>[]): AgentReport<any> => ({
    name: "diet-agent",
    model: "gpt-4",
    promptHash: "abc123",
    tools: ["search"],
    dimensions: { model: "gpt-4" },
    successRate: 0.5,
    failedCases: results.filter((r) => !r.passed).map((r) => r.prompt),
    failedCaseErrors: {},
    timestamp: "2026-06-02T18:30:00.000Z",
    duration: 18,
    totalCases: results.length,
    casesPassed: results.filter((r) => r.passed).length,
    runsPerScene: 1,
    results,
  });

  it("writes one case JSON per scene (pass AND fail), run.json, and a run FAILURES.md", async () => {
    const sweepDir = await mkdtemp(join(tmpdir(), "agest-sweep-"));
    const runId = "sweep1-deadbeef";
    const report = makeReport([passingScene, failingScene]);

    const rel = await writeRunArtifacts(sweepDir, runId, report);
    expect(rel).toContain(join("runs", runId));

    const runDir = join(sweepDir, "runs", runId);
    const cases = await readdir(join(runDir, "cases"));
    expect(cases).toHaveLength(2); // green case is persisted too

    // The passing case carries the resolved response for later double-checking.
    const greenFile = cases.find((f) => f.startsWith("selection-pick-a-plan-"))!;
    const green = JSON.parse(await readFile(join(runDir, "cases", greenFile), "utf-8"));
    expect(green.passed).toBe(true);
    expect(green.resolvedValue).toEqual({ a: 1 });

    const manifest = JSON.parse(await readFile(join(runDir, "run.json"), "utf-8"));
    expect(manifest.runId).toBe(runId);
    expect(manifest.model).toBe("gpt-4");
    expect(manifest.agestVersion).toMatch(/^\d+\./);
    expect(typeof manifest.git.dirty).toBe("boolean");

    const failuresMd = await readFile(join(runDir, "FAILURES.md"), "utf-8");
    expect(failuresMd).toContain("maria cena only");
  });

  it("seals the sweep with a manifest, concatenated FAILURES.md, and a latest pointer", async () => {
    // Mirror the real layout (<reports>/sweeps/<id>) so the `latest` pointer,
    // which is written two levels up, lands inside our temp root.
    const reportsRoot = await mkdtemp(join(tmpdir(), "agest-reports-"));
    const sweepDir = join(reportsRoot, "sweeps", "2026-06-02__sweep2");
    await writeRunArtifacts(sweepDir, "sweep2-aaaa", makeReport([failingScene]));

    await finalizeSweep(sweepDir, {
      sweepId: "sweep2",
      timestamp: "2026-06-02T18:30:00.000Z",
      agestVersion: agestVersion(),
      git: gitInfo(),
      files: 1,
      totalCases: 1,
      casesPassed: 0,
      casesFailed: 1,
      durationMs: 5,
    });

    const manifest = JSON.parse(await readFile(join(sweepDir, "manifest.json"), "utf-8"));
    expect(manifest.sweepId).toBe("sweep2");
    expect(manifest.casesFailed).toBe(1);

    const rollup = await readFile(join(sweepDir, "FAILURES.md"), "utf-8");
    expect(rollup).toContain("maria cena only");

    // `latest` lives in the reports root (two levels up from the sweep dir).
    const latest = await stat(join(reportsRoot, "latest")).catch(() => null);
    const latestTxt = await stat(join(reportsRoot, "latest.txt")).catch(() => null);
    expect(latest || latestTxt).not.toBeNull(); // symlink, or text fallback on restricted FS
  });
});
