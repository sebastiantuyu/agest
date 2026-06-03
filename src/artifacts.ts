import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile, rm, symlink, readdir, readFile } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import type { AgentReport, CaseArtifact, SceneResult } from "./types.js";
import { resolveValue, resolveText } from "./resolve.js";

/**
 * Per-run artifact store: every `agent()` execution leaves a self-contained
 * folder so a run can be inspected later without a re-run. Separate from
 * `.reports/checkpoints.jsonl` (the cross-sweep time-series).
 */

const ACTUAL_VALUE_INLINE = 200;
const RESOLVED_BLOCK_CAP = 2_000;

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
 * Filesystem-safe, stable filename. The hash suffix is mandatory — it keeps two
 * prompts sharing an 80-char prefix distinct, and the name stable across sweeps.
 */
export function slugCase(suite: string | undefined, prompt: string): string {
  const base = [suite, prompt].filter(Boolean).join("__");
  const safe = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const clipped = safe.slice(0, 80).replace(/-+$/g, "") || "case";
  const hash = createHash("sha256").update(base).digest("hex").slice(0, 8);
  return `${clipped}-${hash}`;
}

/** Failures rollup derived from the in-memory artifacts (single source of truth). */
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

/** Current git SHA + dirty flag. Failure-tolerant — git may be absent in CI/sandboxes. */
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

/** agest's own version — resolved relative to this module, not the consumer's cwd. */
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

/**
 * Write one run's artifacts (run.json + cases/ + FAILURES.md) into the sweep
 * folder. Returns the run dir relative to cwd. Caller wraps in try/catch.
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
 * Seal a sweep once every child run is written: manifest, the concatenated
 * FAILURES.md rollup, and the `latest` pointer. Best-effort; never throws.
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
