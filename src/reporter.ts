import { access, mkdir, writeFile } from "fs/promises";
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
  name?: string
): Promise<string> {
  const reportsDir = join(process.cwd(), ".reports");
  await mkdir(reportsDir, { recursive: true });

  const safestamp = timestamp.replace(/[:.]/g, "-");
  const safename = name ? `-${name.replace(/[^a-zA-Z0-9_-]/g, "_")}` : "";
  const filename = `report${safename}-${safestamp}.yaml`;
  const filepath = join(reportsDir, filename);

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
