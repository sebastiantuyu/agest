import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { AgentReport } from "./types";

export function formatReport(report: AgentReport): string {
  const lines: string[] = [
    "agent:",
    `    model: "${report.model ?? "unknown"}"`,
    `    system_prompt: ${report.systemPromptHash ?? "<unknown>"}`,
    `    tools: ${JSON.stringify(report.tools ?? [])}`,
    `    success_rate: ${report.successRate}`,
    `    failed_cases_count: ${report.failedCases.length}`,
    `    failed_cases:`,
  ];

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
  timestamp: string
): Promise<string> {
  const reportsDir = join(process.cwd(), "reports");
  await mkdir(reportsDir, { recursive: true });

  const safestamp = timestamp.replace(/[:.]/g, "-");
  const filename = `report-${safestamp}.yaml`;
  const filepath = join(reportsDir, filename);

  await writeFile(filepath, content, "utf-8");
  return filepath;
}
