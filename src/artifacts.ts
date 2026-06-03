import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile, rm, symlink, readdir, readFile } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import type { AgentReport, CaseArtifact, SceneResult } from "./types.js";
import { resolveValue, resolveText } from "./resolve.js";

/**
 * Per-run/per-sweep artifact store. A run is expensive and rarely repeated, so
 * every `agent()` execution leaves an immutable, self-contained folder under
 * `.reports/sweeps/<sweep>/runs/<runId>/`: one JSON per scene (pass AND fail)
 * carrying the agent's resolved response, plus provenance and a failures
 * rollup. The goal is "diagnose (or double-check) without a re-run".
 *
 * `.reports/checkpoints.jsonl` (the cross-sweep time-series) is untouched — a
 * different job, written elsewhere.
 */

const ACTUAL_VALUE_INLINE = 200;
const RESOLVED_BLOCK_CAP = 2_000;

// ---------------------------------------------------------------------------
// Pure builders (no I/O — trivially testable)
// ---------------------------------------------------------------------------

/** Project a `SceneResult` to the on-disk per-case artifact. Pure. */
export function buildCaseArtifact<T>(r: SceneResult<T>): CaseArtifact {
  const runBreakdown = r.runs?.map((run, index) => ({
    index,
    passed: run.passed,
    error: run.error,
  }));

  return {
    prompt: r.prompt,
    suite: r.suite,
    passed: r.passed,
    resolvedValue: resolveValue(r.response),
    text: resolveText(r.response),
    judge: r.judgement,
    assertions: r.assertions ?? [],
    error: r.error,
    tokens: r.tokens,
    costUsd: r.costUsd,
    durationMs: Math.round(r.duration),
    passRate: r.passRate,
    significance: r.statisticalSignificance,
    runBreakdown: runBreakdown && runBreakdown.length > 1 ? runBreakdown : undefined,
  };
}

/**
 * A filesystem-safe, stable, collision-proof case filename. The 8-char hash of
 * the full `suite__prompt` is mandatory (not "for long prompts only") — it both
 * disambiguates two prompts sharing an 80-char prefix and keeps the same logical
 * case stably named across sweeps so it can be diffed.
 */
export function slugCase(suite: string | undefined, prompt: string): string {
  const base = [suite, prompt].filter(Boolean).join("__");
  const safe = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const clipped = safe.slice(0, 80).replace(/-+$/g, "") || "case";
  const hash = createHash("sha256").update(base).digest("hex").slice(0, 8);
  return `${clipped}-${hash}`;
}

/**
 * Markdown failures rollup, DERIVED from the in-memory case artifacts (never
 * hand-authored, never re-read from JSON — single source of truth). Only red
 * cases appear.
 */
export function renderFailuresMarkdown(failures: CaseArtifact[], agentName?: string): string {
  const lines: string[] = [];
  lines.push(agentName ? `# Failures — ${agentName}` : "# Failures", "");
  lines.push(`${failures.length} failing case${failures.length === 1 ? "" : "s"}.`, "");

  for (const f of failures) {
    const title = [f.suite, f.prompt].filter(Boolean).join(" › ") || f.prompt;
    lines.push(`## ${title}`, "");
    if (f.error) lines.push(`**Error:** ${f.error}`, "");

    const failed = f.assertions.filter((a) => !a.passed);
    if (failed.length) {
      lines.push("**Failing checks:**", "");
      for (const a of failed) {
        lines.push(`- \`${a.field}\`${a.message ? ` — ${a.message}` : ""}`);
        if (a.actualValue) lines.push(`  - actual: \`${inline(a.actualValue)}\``);
      }
      lines.push("");
    }

    if (f.judge && f.judge.verdict !== "pass") {
      lines.push(`**Judge (${f.judge.verdict}):** ${f.judge.reasoning}`, "");
    }

    lines.push("**Resolved value:**", "", "```json", block(safeJson(f.resolvedValue)), "```", "");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** Current git SHA + dirty flag. Failure-tolerant — CI/sandboxes without git must not crash. */
export function gitInfo(): { sha?: string; dirty: boolean } {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return { sha, dirty: status.length > 0 };
  } catch {
    return { dirty: false };
  }
}

/**
 * The installed agest version — read from THIS package's package.json (resolved
 * relative to the module, NOT process.cwd() which is the consumer's project).
 * Works in both `dist/` (build) and `src/` (tsx dev): `../package.json` is the
 * package root from either.
 */
export function agestVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export interface SweepManifest {
  sweepId: string;
  timestamp: string;
  agestVersion: string;
  git: { sha?: string; dirty: boolean };
  files: number;
  totalCases?: number;
  casesPassed?: number;
  casesFailed?: number;
  durationMs?: number;
  totalCostUsd?: number | null;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/**
 * Write the per-run artifacts (run.json + cases/ + a run-local FAILURES.md) for
 * one `agent()` execution into the shared sweep folder. Returns the run dir
 * relative to cwd (the `artifactsDir` link stored on the checkpoint). The caller
 * wraps this in try/catch — artifact writing must never break a run.
 */
export async function writeRunArtifacts(
  sweepDir: string,
  runId: string,
  report: AgentReport<unknown>,
): Promise<string> {
  const runDir = join(sweepDir, "runs", runId);
  const casesDir = join(runDir, "cases");
  await mkdir(casesDir, { recursive: true });

  const artifacts = report.results.map((r) => buildCaseArtifact(r));

  await Promise.all(
    artifacts.map((a) =>
      writeFile(
        join(casesDir, `${slugCase(a.suite, a.prompt)}.json`),
        JSON.stringify(a, null, 2),
        "utf-8",
      ),
    ),
  );

  await writeFile(
    join(runDir, "run.json"),
    JSON.stringify(buildRunManifest(runId, report), null, 2),
    "utf-8",
  );

  const failures = artifacts.filter((a) => !a.passed);
  if (failures.length) {
    await writeFile(
      join(runDir, "FAILURES.md"),
      renderFailuresMarkdown(failures, report.name),
      "utf-8",
    );
  }

  return relative(process.cwd(), runDir);
}

/** Per-run provenance written to `run.json`. */
function buildRunManifest(runId: string, report: AgentReport<unknown>) {
  return {
    runId,
    sweepId: process.env.AGEST_SWEEP_ID ?? null,
    agentName: report.name,
    timestamp: report.timestamp,
    agestVersion: agestVersion(),
    git: gitInfo(),
    model: report.model,
    promptHash: report.promptHash,
    systemPromptHash: report.systemPromptHash,
    tools: report.tools,
    dimensions: report.dimensions,
    runsPerScene: report.runsPerScene,
    totalCases: report.totalCases,
    casesPassed: report.casesPassed,
    successRate: report.successRate,
    wilsonLow: report.wilsonLow,
    wilsonHigh: report.wilsonHigh,
    durationMs: report.duration,
    totalCostUsd: report.totalCostUsd ?? null,
    totalInputTokens: report.totalInputTokens,
    totalOutputTokens: report.totalOutputTokens,
  };
}

/**
 * Finalize a sweep AFTER every child has written its runs: the sweep-level
 * `manifest.json`, the concatenated top-level `FAILURES.md` (gathered from each
 * run's slice — no cross-process write contention), and the `latest` pointer.
 * Best-effort throughout; never throws.
 */
export async function finalizeSweep(sweepDir: string, manifest: SweepManifest): Promise<void> {
  try {
    await writeFile(join(sweepDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  } catch {
    /* ignore */
  }
  await concatFailures(sweepDir);
  await updateLatest(sweepDir);
}

/** Concatenate every run's FAILURES.md into one sweep-level rollup. */
async function concatFailures(sweepDir: string): Promise<void> {
  const runsDir = join(sweepDir, "runs");
  let runIds: string[];
  try {
    runIds = (await readdir(runsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return;
  }

  const sections: string[] = [];
  for (const id of runIds) {
    try {
      sections.push(await readFile(join(runsDir, id, "FAILURES.md"), "utf-8"));
    } catch {
      /* run had no failures — skip */
    }
  }
  if (!sections.length) return;

  try {
    await writeFile(join(sweepDir, "FAILURES.md"), sections.join("\n\n---\n\n"), "utf-8");
  } catch {
    /* ignore */
  }
}

/** Point `.reports/latest` at the newest sweep; fall back to a text pointer on Windows/EPERM. */
async function updateLatest(sweepDir: string): Promise<void> {
  const reportsDir = dirname(dirname(sweepDir)); // .../.reports
  const latest = join(reportsDir, "latest");
  try {
    await rm(latest, { force: true, recursive: true });
    await symlink(relative(reportsDir, sweepDir), latest, "dir");
  } catch {
    try {
      await writeFile(join(reportsDir, "latest.txt"), `${sweepDir}\n`, "utf-8");
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function inline(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > ACTUAL_VALUE_INLINE
    ? oneLine.slice(0, ACTUAL_VALUE_INLINE) + "…"
    : oneLine;
}

function block(s: string): string {
  return s.length > RESOLVED_BLOCK_CAP
    ? s.slice(0, RESOLVED_BLOCK_CAP) + `\n… (+${s.length - RESOLVED_BLOCK_CAP} chars)`
    : s;
}
