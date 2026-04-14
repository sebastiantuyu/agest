import { access, mkdir, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { join } from "path";
import type { AgentReport } from "./types";

export function formatReport(report: AgentReport): string {
  const lines: string[] = ["agent:"];

  if (report.name) lines.push(`    name: "${report.name}"`);

  lines.push(
    `    model: "${report.model ?? "unknown"}"`,
    `    system_prompt: ${report.systemPromptHash ?? "<unknown>"}`,
    `    prompt_hash: ${report.promptHash ?? "<unknown>"}`,
    `    tools: ${JSON.stringify(report.tools ?? [])}`,
  );

  if (report.dimensions && Object.keys(report.dimensions).length > 0) {
    lines.push(`    dimensions:`);
    for (const [key, value] of Object.entries(report.dimensions)) {
      lines.push(`        ${key}: "${value}"`);
    }
  }

  lines.push(
    `    success_rate: ${report.successRate}`,
    `    failed_cases_count: ${report.failedCases.length}`,
    `    failed_cases:`,
  );

  if (report.failedCases.length === 0) {
    lines.push("        (none)");
  } else {
    for (const c of report.failedCases) {
      lines.push(`        - "${c}"`);
      const reason = report.failedCaseErrors[c];
      if (reason) {
        lines.push(`          reason: "${reason}"`);
      }
      const result = report.results.find((r) => r.prompt === c);
      if (result?.response.text) {
        const escaped = result.response.text.replace(/"/g, '\\"').replace(/\n/g, '\\n');
        lines.push(`          response: "${escaped}"`);
      }
    }
  }

  // Suite breakdown
  const suites = new Set(report.results.map((r) => r.suite).filter(Boolean));
  if (suites.size > 0) {
    lines.push(`    suites:`);
    for (const s of suites) {
      const suiteResults = report.results.filter((r) => r.suite === s);
      const suitePassed = suiteResults.filter((r) => r.passed).length;
      const suiteRate = suiteResults.length > 0
        ? Number((suitePassed / suiteResults.length).toFixed(2))
        : 0;
      lines.push(`        - name: "${s}"`);
      lines.push(`          success_rate: ${suiteRate}`);
      lines.push(`          total_cases: ${suiteResults.length}`);
      lines.push(`          failed_cases_count: ${suiteResults.length - suitePassed}`);
      if (suitePassed < suiteResults.length) {
        lines.push(`          failed_cases:`);
        for (const r of suiteResults.filter((r) => !r.passed)) {
          lines.push(`              - "${r.prompt}"`);
          if (r.error) {
            lines.push(`                reason: "${r.error}"`);
          }
          if (r.response.text) {
            const escaped = r.response.text.replace(/"/g, '\\"').replace(/\n/g, '\\n');
            lines.push(`                response: "${escaped}"`);
          }
        }
      }
    }
  }

  // Statistical runs summary
  const withRuns = report.results.filter((r) => r.runs && r.runs.length > 1);
  if (withRuns.length > 0) {
    lines.push(`    statistical_runs:`);
    for (const r of withRuns) {
      const label = r.prompt.length > 50 ? r.prompt.slice(0, 47) + "..." : r.prompt;
      lines.push(`        - "${label}"`);
      lines.push(`          runs: ${r.runs!.length}`);
      lines.push(`          pass_rate: ${((r.passRate ?? 0) * 100).toFixed(1)}%`);
      lines.push(`          significance: ${((r.statisticalSignificance ?? 0) * 100).toFixed(1)}%`);
    }
  }

  lines.push(
    `    timestamp: "${report.timestamp}"`,
    `    duration: ${report.duration}`,
    `    total_cases: ${report.totalCases}`
  );

  if (report.averageInputTokensPerCase != null) {
    lines.push(
      `    average_input_tokens_per_case: ${report.averageInputTokensPerCase}`
    );
  }

  if (report.averageOutputTokensPerCase != null) {
    lines.push(
      `    average_output_tokens_per_case: ${report.averageOutputTokensPerCase}`
    );
  }

  return lines.join("\n");
}

export async function writeReport(
  content: string,
  timestamp: string,
  name?: string,
  dimensions?: Record<string, string>
): Promise<string> {
  const reportsDir = join(process.cwd(), ".reports");
  await mkdir(reportsDir, { recursive: true });

  const safename = name ? `-${name.replace(/[^a-zA-Z0-9_-]/g, "_")}` : "";
  let filename: string;

  if (dimensions && Object.keys(dimensions).length > 0) {
    const sorted = Object.entries(dimensions).sort(([a], [b]) => a.localeCompare(b));
    const dimHash = createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 8);
    filename = `report${safename}-${dimHash}.yaml`;
  } else {
    const safestamp = timestamp.replace(/[:.]/g, "-");
    filename = `report${safename}-${safestamp}.yaml`;
  }

  const filepath = join(reportsDir, filename);

  try {
    await access(filepath);
    console.warn(`\x1b[33m⚠ Overwriting previous report for ${name ?? "unnamed"} (same config)\x1b[0m`);
  } catch {}

  await writeFile(filepath, content, "utf-8");
  return filepath;
}

export async function writeDiffEntry(
  hash: string,
  systemPrompt: string,
  tools: string[],
  model?: string
): Promise<void> {
  const diffDir = join(process.cwd(), ".diff");
  await mkdir(diffDir, { recursive: true });
  const filepath = join(diffDir, `${hash}.yaml`);

  try {
    await access(filepath);
    return; // already exists — skip
  } catch {}

  const lines = [
    `system_prompt: |`,
    ...systemPrompt.split("\n").map((l) => `  ${l}`),
    `tools: ${JSON.stringify(tools)}`,
  ];
  if (model) lines.push(`model: "${model}"`);
  await writeFile(filepath, lines.join("\n"), "utf-8");
}
