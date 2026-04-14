import { readFile, writeFile } from "fs/promises";
import { join, relative } from "path";
import os from "os";
import { exec } from "child_process";
import {
  type ParsedReport,
  type ControlledComparison,
  type DiffEntry,
  parseReport,
  findReports,
  loadDiffEntry,
  wilsonLowerBound,
  computeDiff,
  formatDuration,
  ensureDimensions,
  findVaryingDimensions,
  groupByDimension,
  findControlledPairs,
  diffConfigs,
} from "./reports.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunEntry {
  report: ParsedReport;
  delta?: number;
  diffLines: string[];
}

interface AgentGroup {
  label: string;
  runs: RunEntry[];
  varyingDims: string[];
  controlledPairs: ControlledComparison[];
  diffEntries: (DiffEntry | null)[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openBrowser(filepath: string) {
  const cmd =
    process.platform === "win32"
      ? `start "" "${filepath}"`
      : process.platform === "darwin"
      ? `open "${filepath}"`
      : `xdg-open "${filepath}"`;
  exec(cmd, (err) => {
    if (err) console.error("  Could not open browser:", err.message);
  });
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function barColor(rate: number): string {
  if (rate >= 0.8) return "#4ade80";
  if (rate >= 0.5) return "#facc15";
  return "#f87171";
}

function rateClass(rate: number): string {
  if (rate >= 0.8) return "text-green-400";
  if (rate >= 0.5) return "text-yellow-400";
  return "text-red-400";
}

function deltaClass(delta: number): string {
  if (delta > 0) return "text-green-400";
  if (delta < 0) return "text-red-400";
  return "text-zinc-500";
}

function formatDelta(d: number): string {
  if (Math.abs(d) < 0.5) return "=";
  return (d > 0 ? "+" : "") + d.toFixed(0) + "%";
}

function formatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

// ---------------------------------------------------------------------------
// Smart dimension labels
// ---------------------------------------------------------------------------

/**
 * Build human-readable labels for each unique value of each dimension.
 * - model: short name after "/"
 * - tools: compact tool names or count
 * - prompt: diff-based labels from .diff/ entries when available
 */
function buildSmartLabels(
  sorted: ParsedReport[],
  allDims: string[],
  diffEntries: (DiffEntry | null)[],
): Map<string, Map<string, string>> {
  const labels = new Map<string, Map<string, string>>();

  for (const dim of allDims) {
    const dimLabels = new Map<string, string>();

    if (dim === "model") {
      for (const r of sorted) {
        const val = r.dimensions?.[dim] ?? "?";
        if (!dimLabels.has(val)) {
          const short = val.length > 16 ? val.split("/").pop()?.slice(0, 16) ?? val.slice(0, 16) : val;
          dimLabels.set(val, short);
        }
      }
    } else if (dim === "tools") {
      for (const r of sorted) {
        const val = r.dimensions?.[dim] ?? "?";
        if (!dimLabels.has(val)) {
          if (val === "none") {
            dimLabels.set(val, "no tools");
          } else {
            const toolList = val.split(",");
            if (toolList.length <= 2) {
              dimLabels.set(val, toolList.join(", "));
            } else {
              dimLabels.set(val, `${toolList.length} tools`);
            }
          }
        }
      }
    } else if (dim === "prompt") {
      // Collect unique prompt hashes in chronological order
      const uniqueHashes: string[] = [];
      const hashToDiff = new Map<string, DiffEntry>();
      for (let i = 0; i < sorted.length; i++) {
        const val = sorted[i].dimensions?.[dim] ?? "?";
        if (!uniqueHashes.includes(val)) {
          uniqueHashes.push(val);
          const diff = diffEntries[i];
          if (diff) hashToDiff.set(val, diff);
        }
      }

      for (let j = 0; j < uniqueHashes.length; j++) {
        const hash = uniqueHashes[j];
        const diff = hashToDiff.get(hash);

        if (j === 0) {
          // First prompt: show truncated first line or "baseline"
          if (diff?.systemPrompt) {
            const firstLine = diff.systemPrompt.split("\n").find((l) => l.trim()) ?? "";
            dimLabels.set(hash, firstLine.length > 28 ? firstLine.slice(0, 27) + "…" : firstLine || "baseline");
          } else {
            dimLabels.set(hash, "baseline");
          }
        } else {
          // Subsequent: compute diff snippet vs previous
          const prevHash = uniqueHashes[j - 1];
          const prevDiff = hashToDiff.get(prevHash);
          if (diff && prevDiff) {
            const changes = computeDiff(prevDiff, diff);
            const promptChanges = changes
              .filter((l) => l.startsWith("prompt:"))
              .map((l) => l.replace(/^prompt:\s*/, "").slice(0, 30));
            const toolChanges = changes
              .filter((l) => l.startsWith("tools:"))
              .map((l) => l.replace(/^tools:\s*/, "").slice(0, 30));
            const snippets = [...promptChanges, ...toolChanges].slice(0, 2);
            dimLabels.set(hash, snippets.length > 0 ? snippets.join(", ") : `v${j + 1}`);
          } else {
            dimLabels.set(hash, `v${j + 1}`);
          }
        }
      }
    } else {
      // Generic fallback: version numbering
      let idx = 1;
      for (const r of sorted) {
        const val = r.dimensions?.[dim] ?? "?";
        if (!dimLabels.has(val)) {
          dimLabels.set(val, `v${idx}`);
          idx++;
        }
      }
    }

    labels.set(dim, dimLabels);
  }

  return labels;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTools(tools: string[]): string {
  return tools
    .map(
      (t) =>
        `<span class="text-xs bg-zinc-800 border border-zinc-700 px-2 py-0.5 rounded-full text-zinc-400">${escHtml(t)}</span>`
    )
    .join(" ");
}

function renderFailedCases(
  cases: Array<{ prompt: string; reason?: string }>
): string {
  if (cases.length === 0) return "";
  const items = cases
    .map(
      (fc) => `
          <li class="pl-3 border-l border-zinc-700">
            <div class="text-sm text-zinc-300">&ldquo;${escHtml(fc.prompt)}&rdquo;</div>
            ${fc.reason ? `<div class="text-xs text-zinc-500 mt-1 break-words">${escHtml(fc.reason)}</div>` : ""}
          </li>`
    )
    .join("\n");
  return `
        <details class="mt-4">
          <summary class="text-xs text-red-400 cursor-pointer hover:text-red-300 select-none">
            ${cases.length} failed case${cases.length !== 1 ? "s" : ""}
          </summary>
          <ul class="mt-3 space-y-3">
            ${items}
          </ul>
        </details>`;
}

function renderRunRow(entry: RunEntry, idx: number): string {
  const { report, delta, diffLines } = entry;
  const pct = report.successRate * 100;
  const color = barColor(report.successRate);
  const textColor = rateClass(report.successRate);

  // Show dimension values as tags
  const dims = report.dimensions ?? {};
  const dimTags = Object.entries(dims)
    .map(([k, v]) => {
      const short = v.length > 16 ? v.slice(0, 15) + "…" : v;
      return `<span class="text-xs text-zinc-600" title="${escHtml(v)}">${escHtml(k)}:${escHtml(short)}</span>`;
    })
    .join(" ");

  const deltaHtml =
    delta === undefined
      ? `<span class="w-14 text-right text-zinc-700 text-xs">&mdash;</span>`
      : `<span class="w-14 text-right text-xs ${deltaClass(delta)}">${formatDelta(delta)}</span>`;

  const diffHtml =
    diffLines.length === 0
      ? ""
      : `<div class="ml-10 mt-1 mb-2 pl-3 border-l border-zinc-800 space-y-0.5">
          ${diffLines
            .map((l) => {
              const isAdd = l.includes(": +") || l.startsWith("tools: +");
              const isRem = l.includes(": -") || l.startsWith("tools: -");
              const cls = isAdd
                ? "text-green-600"
                : isRem
                ? "text-red-600"
                : "text-zinc-600";
              return `<div class="text-xs ${cls}">${escHtml(l)}</div>`;
            })
            .join("\n")}
        </div>`;

  return `
        <div>
          <div class="flex items-center gap-3 py-1">
            <span class="text-xs text-zinc-600 w-6 text-right select-none">#${idx + 1}</span>
            <div class="flex-1 bg-zinc-800 rounded h-2.5 overflow-hidden">
              <div class="h-2.5 rounded" style="width:${pct.toFixed(1)}%;background:${color}"></div>
            </div>
            <span class="text-sm font-bold ${textColor} w-12 text-right">${pct.toFixed(0)}%</span>
            ${deltaHtml}
          </div>
          <div class="ml-10 mt-0.5 flex gap-3 flex-wrap">${dimTags}</div>
          ${diffHtml}
        </div>`;
}

// ---------------------------------------------------------------------------
// Radar Chart (suite breakdown)
// ---------------------------------------------------------------------------

const RADAR_COLORS = [
  { border: "#f87171", fill: "rgba(248,113,113,0.15)" },
  { border: "#38bdf8", fill: "rgba(56,189,248,0.15)" },
  { border: "#4ade80", fill: "rgba(74,222,128,0.15)" },
  { border: "#facc15", fill: "rgba(250,204,21,0.15)" },
  { border: "#a78bfa", fill: "rgba(167,139,250,0.15)" },
  { border: "#fb923c", fill: "rgba(251,146,60,0.15)" },
  { border: "#f472b6", fill: "rgba(244,114,182,0.15)" },
  { border: "#2dd4bf", fill: "rgba(45,212,191,0.15)" },
];

function renderRadarChart(group: AgentGroup): string {
  const reportsWithSuites = group.runs
    .map((r) => r.report)
    .filter((r) => r.suites && r.suites.length > 0);

  if (reportsWithSuites.length === 0) return "";

  // Collect all unique suite names
  const allSuiteNames = [
    ...new Set(reportsWithSuites.flatMap((r) => r.suites!.map((s) => s.name))),
  ];

  if (allSuiteNames.length < 3) return ""; // Radar needs at least 3 axes

  // Group by model — each model gets its own dataset
  const byModel = new Map<string, typeof reportsWithSuites>();
  for (const r of reportsWithSuites) {
    const model = r.model ?? "unknown";
    const arr = byModel.get(model) ?? [];
    arr.push(r);
    byModel.set(model, arr);
  }

  const agentId = escHtml(group.label).replace(/\s+/g, "-").toLowerCase();

  // Build one canvas per model + one "all" combined view
  const modelEntries = [...byModel.entries()];
  const allModels = modelEntries.map(([m]) => m);
  const showToggle = allModels.length > 1;

  // "All models" combined dataset
  const allDatasets = modelEntries.map(([model, reports], i) => {
    const latest = reports[reports.length - 1];
    const color = RADAR_COLORS[i % RADAR_COLORS.length];
    const rawData = allSuiteNames.map((suiteName) => {
      const suite = latest.suites!.find((s) => s.name === suiteName);
      return suite ? +(suite.successRate * 100).toFixed(1) : 0;
    });
    const wilsonData = allSuiteNames.map((suiteName) => {
      const suite = latest.suites!.find((s) => s.name === suiteName);
      return suite ? +(wilsonLowerBound(suite.successRate, suite.totalCases) * 100).toFixed(1) : 0;
    });
    const short =
      model.split("/").pop()?.slice(0, 24) ?? model.slice(0, 24);
    return {
      label: short,
      data: rawData,
      _rawData: rawData,
      _wilsonData: wilsonData,
      borderColor: color.border,
      backgroundColor: color.fill,
      pointBackgroundColor: color.border,
      pointBorderColor: "#18181b",
      pointRadius: 4,
      borderWidth: 2,
    };
  });

  const radarOptions = `{
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: {
          color: '#a1a1aa',
          font: { family: 'ui-monospace, monospace', size: 10 },
          boxWidth: 12,
          padding: 16
        }
      },
      tooltip: {
        callbacks: {
          label: function(ctx) { return ctx.dataset.label + ': ' + ctx.parsed.r + '%'; }
        }
      }
    },
    scales: {
      r: {
        min: 0,
        max: 100,
        ticks: {
          color: '#71717a',
          backdropColor: 'transparent',
          font: { family: 'ui-monospace, monospace', size: 9 },
          callback: function(v) { return v + '%'; }
        },
        pointLabels: {
          color: '#a1a1aa',
          font: { family: 'ui-monospace, monospace', size: 11 }
        },
        grid: { color: '#27272a' },
        angleLines: { color: '#27272a' }
      }
    }
  }`;

  // Build combined radar canvas
  const allCanvasId = `radar-all-${agentId}`;
  let canvasesHtml = `
    <div class="radar-model-view" data-agent="${agentId}" data-model="__all__" style="display:block">
      <div style="position:relative;height:400px">
        <canvas id="${allCanvasId}"></canvas>
      </div>
      <script>
        (function() {
          var chart = new Chart(document.getElementById('${allCanvasId}'), {
            type: 'radar',
            data: {
              labels: ${JSON.stringify(allSuiteNames)},
              datasets: ${JSON.stringify(allDatasets)}
            },
            options: ${radarOptions}
          });
          window.__agestCharts['${allCanvasId}'] = chart;
        })();
      </script>
    </div>`;

  // Per-model radar canvases (hidden by default)
  if (showToggle) {
    for (let i = 0; i < modelEntries.length; i++) {
      const [model, reports] = modelEntries[i];
      const latest = reports[reports.length - 1];
      const color = RADAR_COLORS[i % RADAR_COLORS.length];
      const rawData = allSuiteNames.map((suiteName) => {
        const suite = latest.suites!.find((s) => s.name === suiteName);
        return suite ? +(suite.successRate * 100).toFixed(1) : 0;
      });
      const wilsonData = allSuiteNames.map((suiteName) => {
        const suite = latest.suites!.find((s) => s.name === suiteName);
        return suite ? +(wilsonLowerBound(suite.successRate, suite.totalCases) * 100).toFixed(1) : 0;
      });
      const short =
        model.split("/").pop()?.slice(0, 24) ?? model.slice(0, 24);
      const canvasId = `radar-${agentId}-${i}`;
      const safeModel = escHtml(model);

      canvasesHtml += `
    <div class="radar-model-view" data-agent="${agentId}" data-model="${safeModel}" style="display:none">
      <div style="position:relative;height:400px">
        <canvas id="${canvasId}"></canvas>
      </div>
      <script>
        (function() {
          var chart = new Chart(document.getElementById('${canvasId}'), {
            type: 'radar',
            data: {
              labels: ${JSON.stringify(allSuiteNames)},
              datasets: [${JSON.stringify({
                label: short,
                data: rawData,
                _rawData: rawData,
                _wilsonData: wilsonData,
                borderColor: color.border,
                backgroundColor: color.fill,
                pointBackgroundColor: color.border,
                pointBorderColor: "#18181b",
                pointRadius: 4,
                borderWidth: 2,
              })}]
            },
            options: ${radarOptions}
          });
          window.__agestCharts['${canvasId}'] = chart;
        })();
      </script>
    </div>`;
    }
  }

  // Model selector dropdown (only when multiple models)
  const modelSelector = showToggle
    ? `<select class="radar-model-select bg-zinc-800 text-zinc-300 text-xs border border-zinc-700 rounded px-2 py-1"
        data-agent="${agentId}"
        onchange="filterRadarModel('${agentId}', this.value)">
        <option value="__all__">All Models</option>
        ${allModels.map((m) => `<option value="${escHtml(m)}">${escHtml(m.split("/").pop()?.slice(0, 30) ?? m.slice(0, 30))}</option>`).join("\n")}
      </select>`
    : "";

  return `
    <div class="rounded-xl border border-zinc-800 bg-zinc-900 p-5 mb-4">
      <div class="flex items-center justify-between mb-4">
        <span class="text-xs text-zinc-600 uppercase tracking-wider">suite breakdown</span>
        ${modelSelector}
      </div>
      ${canvasesHtml}
    </div>`;
}

// ---------------------------------------------------------------------------
// Grouped Bar Chart (benchmark-style)
// ---------------------------------------------------------------------------

const SERIES_COLORS = [
  { bg: "#f87171", text: "#fca5a5" },  // red
  { bg: "#fb923c", text: "#fdba74" },  // orange
  { bg: "#facc15", text: "#fde047" },  // yellow
  { bg: "#4ade80", text: "#86efac" },  // green
  { bg: "#38bdf8", text: "#7dd3fc" },  // sky
  { bg: "#a78bfa", text: "#c4b5fd" },  // violet
  { bg: "#f472b6", text: "#f9a8d4" },  // pink
  { bg: "#2dd4bf", text: "#5eead4" },  // teal
];

function renderMatrixView(
  sorted: ParsedReport[],
  groupDim: string,
  allDims: string[],
  versionMaps: Map<string, Map<string, string>>,
  dimLabel: (dim: string, val: string) => string,
): string {
  const otherDims = allDims.filter((d) => d !== groupDim);

  // Column dimension: prefer "model", else first other dim
  const colDim = otherDims.includes("model") ? "model" : otherDims[0];
  if (!colDim) return "";

  // Remaining dims shown as tags in row labels
  const tagDims = otherDims.filter((d) => d !== colDim);

  // Unique column values (in order of first appearance)
  const colVals = [...new Set(sorted.map((r) => r.dimensions?.[colDim] ?? "?"))];

  // Build row entries: unique combinations of groupDim + tagDims
  const rowEntriesMap = new Map<string, { groupVal: string; tagVals: Record<string, string>; key: string }>();
  for (const r of sorted) {
    const gv = r.dimensions?.[groupDim] ?? "?";
    const tags: Record<string, string> = {};
    for (const td of tagDims) {
      tags[td] = r.dimensions?.[td] ?? "?";
    }
    const key = [gv, ...tagDims.map((td) => tags[td])].join("|");
    if (!rowEntriesMap.has(key)) {
      rowEntriesMap.set(key, { groupVal: gv, tagVals: tags, key });
    }
  }
  const rowEntries = [...rowEntriesMap.values()];

  // Lookup: rowKey||colVal -> report (latest wins since sorted chronologically)
  const lookup = new Map<string, ParsedReport>();
  for (const r of sorted) {
    const gv = r.dimensions?.[groupDim] ?? "?";
    const tags = tagDims.map((td) => r.dimensions?.[td] ?? "?");
    const rowKey = [gv, ...tags].join("|");
    const cv = r.dimensions?.[colDim] ?? "?";
    lookup.set(`${rowKey}||${cv}`, r);
  }

  // Column headers
  const colHeaders = colVals
    .map((cv) => {
      const label = dimLabel(colDim, cv);
      return `<th class="px-4 py-2 text-xs text-zinc-400 font-medium text-left" title="${escHtml(cv)}">${escHtml(label)}</th>`;
    })
    .join("\n");

  // Rows
  const rows = rowEntries
    .map((row) => {
      const groupLabel = dimLabel(groupDim, row.groupVal);
      const tagHtml = tagDims
        .map((td) => {
          const tl = dimLabel(td, row.tagVals[td]);
          return `<span class="text-[10px] text-zinc-600">${escHtml(td)}: ${escHtml(tl)}</span>`;
        })
        .join(" ");

      const cells = colVals
        .map((cv) => {
          const r = lookup.get(`${row.key}||${cv}`);
          if (!r) {
            return `<td class="px-4 py-2"><span class="text-xs text-zinc-700">&mdash;</span></td>`;
          }
          const pct = r.successRate * 100;
          const wilsonPct = wilsonLowerBound(r.successRate, r.totalCases) * 100;
          const color = barColor(r.successRate);
          const tc = rateClass(r.successRate);
          return `<td class="px-4 py-2">
            <div class="flex items-center gap-3">
              <div class="flex-1 bg-zinc-800 rounded h-2 overflow-hidden" style="min-width:80px">
                <div class="h-2 rounded" style="width:${pct.toFixed(1)}%;background:${color}"></div>
              </div>
              <span class="text-sm font-medium ${tc} w-12 text-right" data-raw="${pct.toFixed(0)}%" data-wilson="${wilsonPct.toFixed(0)}%">${pct.toFixed(0)}%</span>
            </div>
          </td>`;
        })
        .join("\n");

      return `<tr class="border-t border-zinc-800/50">
        <td class="px-4 py-2.5">
          <div class="text-xs text-zinc-300 font-medium">${escHtml(groupLabel)}</div>
          ${tagHtml ? `<div class="flex gap-2 mt-0.5">${tagHtml}</div>` : ""}
        </td>
        ${cells}
      </tr>`;
    })
    .join("\n");

  // Version reference
  const versionRef = allDims
    .map((dim) => {
      const vMap = versionMaps.get(dim)!;
      if (vMap.size <= 1) return "";
      const entries = [...vMap.entries()]
        .map(([val, version]) => {
          const short = val.length > 28 ? val.slice(0, 27) + "…" : val;
          return `<span class="text-zinc-600">${escHtml(version)}</span> <span class="text-zinc-700">${escHtml(short)}</span>`;
        })
        .join("&nbsp;&nbsp;&middot;&nbsp;&nbsp;");
      return `<div class="text-[10px]"><span class="text-zinc-500">${escHtml(dim)}:</span> ${entries}</div>`;
    })
    .filter(Boolean)
    .join("\n");

  return `
    <div class="overflow-x-auto">
      <table class="w-full">
        <thead>
          <tr class="border-b border-zinc-800">
            <th class="px-4 py-2 text-xs text-zinc-500 font-medium text-left">${escHtml(groupDim)}</th>
            ${colHeaders}
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
    <div class="mt-4 pt-3 border-t border-zinc-800/50 space-y-1">
      ${versionRef}
    </div>`;
}

function renderGroupedBarChart(group: AgentGroup): string {
  const reports = group.runs.map((r) => r.report);
  const varying = [...group.varyingDims];
  // Prefer "model" as default tab — it has human-readable labels
  const modelIdx = varying.indexOf("model");
  if (modelIdx > 0) {
    varying.splice(modelIdx, 1);
    varying.unshift("model");
  }
  const allDims = [...new Set(reports.flatMap((r) => Object.keys(r.dimensions ?? {})))];

  if (varying.length < 1) return "";

  const agentId = escHtml(group.label).replace(/\s+/g, "-").toLowerCase();

  const sorted = [...reports].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Build smart labels using diff entries for prompt/tools readability
  const versionMaps = buildSmartLabels(sorted, allDims, group.diffEntries);

  const dimLabel = (dim: string, val: string): string => {
    return versionMaps.get(dim)?.get(val) ?? val;
  };

  // Build a chart for each possible grouping dimension
  const charts = varying.map((groupDim, dimIdx) => {
    const isActive = dimIdx === 0;

    // Also render a matrix/table view for non-model dimensions (hidden by default)
    const matrixHtml = groupDim !== "model"
      ? renderMatrixView(sorted, groupDim, allDims, versionMaps, dimLabel)
      : "";

    const otherDims = allDims.filter((d) => d !== groupDim);

    // Group runs by the grouping dimension
    const groupVals = [...new Set(sorted.map((r) => r.dimensions?.[groupDim] ?? "?"))];
    const grouped = new Map<string, ParsedReport[]>();
    for (const r of sorted) {
      const gv = r.dimensions?.[groupDim] ?? "?";
      const arr = grouped.get(gv) ?? [];
      arr.push(r);
      grouped.set(gv, arr);
    }

    // Config key = unique combo of non-grouping dims
    const configKey = (r: ParsedReport) =>
      otherDims.map((d) => r.dimensions?.[d] ?? "?").join("|");
    const uniqueConfigs = [...new Set(sorted.map(configKey))];

    // X-axis labels: model short names
    const labels = groupVals.map((gv) => dimLabel(groupDim, gv));

    // Build Chart.js datasets: one per unique config
    const datasets = uniqueConfigs.map((ck, ci) => {
      const color = SERIES_COLORS[ci % SERIES_COLORS.length];
      const parts = ck.split("|");
      const cfgLabel = otherDims.map((d, i) => `${d}: ${dimLabel(d, parts[i] ?? "?")}`).join(", ");

      const rawData = groupVals.map((gv) => {
        const groupRuns = grouped.get(gv) ?? [];
        const match = groupRuns.find((r) => configKey(r) === ck);
        return match ? +(match.successRate * 100).toFixed(1) : null;
      });
      const wilsonData = groupVals.map((gv) => {
        const groupRuns = grouped.get(gv) ?? [];
        const match = groupRuns.find((r) => configKey(r) === ck);
        return match ? +(wilsonLowerBound(match.successRate, match.totalCases) * 100).toFixed(1) : null;
      });

      return { label: cfgLabel, data: rawData, _rawData: rawData, _wilsonData: wilsonData, backgroundColor: color.bg, borderColor: color.bg, borderWidth: 0, borderRadius: 4 };
    });

    const canvasId = `bar-${agentId}-${escHtml(groupDim)}`;

    // Version reference
    const versionRef = allDims
      .map((dim) => {
        const vMap = versionMaps.get(dim)!;
        if (vMap.size <= 1) return "";
        const entries = [...vMap.entries()]
          .map(([val, version]) => {
            const short = val.length > 28 ? val.slice(0, 27) + "…" : val;
            return `<span class="text-zinc-600">${escHtml(version)}</span> <span class="text-zinc-700">${escHtml(short)}</span>`;
          })
          .join("&nbsp;&nbsp;&middot;&nbsp;&nbsp;");
        return `<div class="text-[10px]"><span class="text-zinc-500">${escHtml(dim)}:</span> ${entries}</div>`;
      })
      .filter(Boolean)
      .join("\n");

    const viewToggle = matrixHtml ? `<button
        class="view-toggle text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
        data-agent="${agentId}" data-dim="${escHtml(groupDim)}"
        onclick="switchView('${agentId}', '${escHtml(groupDim)}')"
      >Table</button>` : "";

    return `<div class="chart-view" data-agent="${agentId}" data-dim="${escHtml(groupDim)}" style="display:${isActive ? "block" : "none"}">
      <div class="flex items-center justify-between mb-4">
        <div class="text-xs text-zinc-600 uppercase tracking-wider">grouped by ${escHtml(groupDim)}</div>
        ${viewToggle}
      </div>
      <div class="bar-view" data-agent="${agentId}" data-dim="${escHtml(groupDim)}">
        <div style="position:relative;height:280px">
          <canvas id="${canvasId}"></canvas>
        </div>
        <script>
          (function() {
            var chart = new Chart(document.getElementById('${canvasId}'), {
              type: 'bar',
              data: { labels: ${JSON.stringify(labels)}, datasets: ${JSON.stringify(datasets)} },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: { labels: { color: '#a1a1aa', font: { family: 'ui-monospace, monospace', size: 10 }, boxWidth: 12, padding: 16 } },
                  tooltip: { callbacks: { label: function(ctx) { return ctx.dataset.label + ': ' + ctx.parsed.y + '%'; } } }
                },
                scales: {
                  x: { ticks: { color: '#71717a', font: { family: 'ui-monospace, monospace', size: 10 } }, grid: { color: '#27272a' } },
                  y: { min: 0, max: 100, ticks: { color: '#71717a', font: { family: 'ui-monospace, monospace', size: 10 }, callback: function(v) { return v + '%'; } }, grid: { color: '#27272a' } }
                }
              }
            });
            window.__agestCharts['${canvasId}'] = chart;
          })();
        </script>
        <div class="mt-4 pt-3 border-t border-zinc-800/50 space-y-1">
          ${versionRef}
        </div>
      </div>
      ${matrixHtml ? `<div class="table-view" data-agent="${agentId}" data-dim="${escHtml(groupDim)}" style="display:none">${matrixHtml}</div>` : ""}
    </div>`;
  });

  // Primary dimension selector
  const dimOptions = varying
    .map((dim) => `<option value="${escHtml(dim)}">${escHtml(dim)}</option>`)
    .join("\n");

  const dimSelector = varying.length > 1
    ? `<div class="flex items-center gap-2">
        <span class="text-[10px] text-zinc-600 uppercase tracking-wider">Group by</span>
        <select class="bg-zinc-800 text-zinc-300 text-xs border border-zinc-700 rounded px-2 py-1"
          onchange="switchDim('${agentId}', this.value)">
          ${dimOptions}
        </select>
      </div>`
    : `<span class="text-[10px] text-zinc-600">grouped by ${escHtml(varying[0])}</span>`;

  return `
    <div class="rounded-xl border border-zinc-800 bg-zinc-900 p-5 mb-4">
      <div class="flex items-center justify-between mb-5">
        <span class="text-xs text-zinc-600 uppercase tracking-wider">success rate</span>
        ${dimSelector}
      </div>
      ${charts.join("\n")}
    </div>`;
}

// ---------------------------------------------------------------------------
// Attribution Cards
// ---------------------------------------------------------------------------

function renderAttribution(group: AgentGroup): string {
  const pairs = group.controlledPairs;
  if (pairs.length === 0) return "";

  // Group by dimension
  const byDim = new Map<string, { deltas: number[]; pairs: ControlledComparison[] }>();
  for (const p of pairs) {
    const entry = byDim.get(p.variedDimension) ?? { deltas: [], pairs: [] };
    entry.deltas.push(p.delta);
    entry.pairs.push(p);
    byDim.set(p.variedDimension, entry);
  }

  const sorted = [...byDim.entries()].sort(
    (a, b) => Math.max(...b[1].deltas.map(Math.abs)) - Math.max(...a[1].deltas.map(Math.abs))
  );

  const cards = sorted
    .map(([dim, { deltas, pairs: dimPairs }]) => {
      const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      const sign = avgDelta > 0 ? "+" : "";
      const avgStr = `${sign}${(avgDelta * 100).toFixed(0)}%`;
      const color = avgDelta > 0 ? "text-green-400" : avgDelta < 0 ? "text-red-400" : "text-zinc-500";

      const examples = dimPairs.slice(0, 3).map((p) => {
        const d = (p.delta * 100).toFixed(0);
        const s = p.delta > 0 ? "+" : "";
        const exColor = p.delta > 0 ? "text-green-600" : p.delta < 0 ? "text-red-600" : "text-zinc-600";
        const fromLabel = p.variedFrom.length > 20 ? p.variedFrom.slice(0, 19) + "…" : p.variedFrom;
        const toLabel = p.variedTo.length > 20 ? p.variedTo.slice(0, 19) + "…" : p.variedTo;
        return `<div class="text-xs ${exColor}">${escHtml(fromLabel)} &rarr; ${escHtml(toLabel)}: ${s}${d}%</div>`;
      }).join("\n");

      return `
        <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
          <div class="flex items-center justify-between mb-2">
            <span class="text-sm text-zinc-300 font-medium">${escHtml(dim)}</span>
            <span class="text-lg font-bold ${color}">${avgStr} avg</span>
          </div>
          <div class="text-xs text-zinc-500 mb-2">${deltas.length} controlled comparison${deltas.length !== 1 ? "s" : ""}</div>
          <div class="space-y-1">${examples}</div>
        </div>`;
    })
    .join("\n");

  return `
    <div class="rounded-xl border border-zinc-800 bg-zinc-900 p-5 mb-4">
      <div class="mb-4">
        <span class="text-xs text-zinc-600 uppercase tracking-wider">dimension impact (single-variable comparisons)</span>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        ${cards}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Per-group evolution (grouped by primary dimension)
// ---------------------------------------------------------------------------

function renderGroupedEvolution(group: AgentGroup): string {
  const reports = group.runs.map((r) => r.report);
  const varying = group.varyingDims;

  if (varying.length === 0) {
    // No varying dims — flat timeline
    return renderFlatEvolution(group);
  }

  const primaryDim = varying[0];
  const dimGroups = groupByDimension(reports, primaryDim);

  const cards = [...dimGroups.entries()]
    .map(([dimVal, dimReports]) => {
      const sorted = [...dimReports].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      const entries: RunEntry[] = sorted.map((report, i) => {
        const delta =
          i === 0
            ? undefined
            : (report.successRate - sorted[i - 1].successRate) * 100;

        // Compute diff lines for display
        let diffLines: string[] = [];
        if (i > 0) {
          const prev = sorted[i - 1];
          const diff = diffConfigs(prev.dimensions ?? {}, report.dimensions ?? {});
          diffLines = Object.entries(diff.varied)
            .map(([k, v]) => `${k}: ${v.from} → ${v.to}`)
            .slice(0, 4);
        }

        return { report, delta, diffLines };
      });

      const rows = entries.map((e, i) => renderRunRow(e, i)).join("\n");

      return `
        <div class="rounded-xl border border-zinc-800 bg-zinc-900 p-5 mb-4">
          <div class="flex items-center justify-between mb-4">
            <span class="text-xs text-zinc-600 uppercase tracking-wider">${escHtml(primaryDim)}: ${escHtml(dimVal.length > 30 ? dimVal.slice(0, 29) + "…" : dimVal)}</span>
            <span class="text-xs text-zinc-600">${sorted.length} run${sorted.length !== 1 ? "s" : ""}</span>
          </div>
          <div class="space-y-0">
            ${rows}
          </div>
        </div>`;
    })
    .join("\n");

  return cards;
}

function renderFlatEvolution(group: AgentGroup): string {
  const rows = group.runs.map((e, i) => renderRunRow(e, i)).join("\n");

  return `
    <div class="rounded-xl border border-zinc-800 bg-zinc-900 p-5 mb-4">
      <div class="flex items-center justify-between mb-4">
        <span class="text-xs text-zinc-600 uppercase tracking-wider">success rate &middot; ${group.runs.length} runs</span>
        <span class="text-xs text-zinc-600">oldest &rarr; newest</span>
      </div>
      <div class="space-y-0">
        ${rows}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Agent section
// ---------------------------------------------------------------------------

function renderScatterPlot(group: AgentGroup): string {
  const reports = group.runs.map((r) => r.report);
  if (reports.length < 2) return "";

  const allDims = [...new Set(reports.flatMap((r) => Object.keys(r.dimensions ?? {})))];

  // Group data points by model
  const byModel = new Map<string, { raw: Array<{ x: number; y: number; label: string }>; wilson: Array<{ x: number; y: number; label: string }> }>();
  for (const r of reports) {
    const model = r.dimensions?.["model"] ?? r.model ?? "?";
    const avgDurSec = r.totalCases > 0 ? +(r.duration / r.totalCases / 1000).toFixed(2) : 0;
    const accuracy = +(r.successRate * 100).toFixed(1);
    const wilsonAccuracy = +(wilsonLowerBound(r.successRate, r.totalCases) * 100).toFixed(1);
    const configLabel = allDims
      .filter((d) => d !== "model")
      .map((d) => `${d}: ${r.dimensions?.[d] ?? "?"}`)
      .join(", ");

    const entry = byModel.get(model) ?? { raw: [], wilson: [] };
    entry.raw.push({ x: avgDurSec, y: accuracy, label: configLabel });
    entry.wilson.push({ x: avgDurSec, y: wilsonAccuracy, label: configLabel });
    byModel.set(model, entry);
  }

  const uniqueModels = [...byModel.keys()];
  const datasets = uniqueModels.map((model, i) => {
    const color = SERIES_COLORS[i % SERIES_COLORS.length];
    const short = model.split("/").pop()?.slice(0, 24) ?? model.slice(0, 24);
    const entry = byModel.get(model)!;
    return {
      label: short,
      data: entry.raw,
      _rawScatter: entry.raw,
      _wilsonScatter: entry.wilson,
      backgroundColor: color.bg,
      borderColor: color.text,
      pointRadius: 7,
      pointHoverRadius: 9,
    };
  });

  const allX = [...byModel.values()].flatMap((e) => e.raw).map((p) => p.x);
  const midX = allX.length > 0 ? +((Math.min(...allX) + Math.max(...allX)) / 2).toFixed(2) : 0;

  const agentId = escHtml(group.label).replace(/\s+/g, "-").toLowerCase();
  const canvasId = `scatter-${agentId}`;

  return `
    <div class="rounded-xl border border-zinc-800 bg-zinc-900 p-5 mb-4">
      <div class="mb-4">
        <span class="text-xs text-zinc-600 uppercase tracking-wider">accuracy vs speed</span>
      </div>
      <div style="position:relative;height:320px">
        <canvas id="${canvasId}"></canvas>
      </div>
      <script>
        (function() {
          var chart = new Chart(document.getElementById('${canvasId}'), {
            type: 'scatter',
            data: { datasets: ${JSON.stringify(datasets)} },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: { labels: { color: '#a1a1aa', font: { family: 'ui-monospace, monospace', size: 10 }, boxWidth: 12, padding: 16 } },
                tooltip: {
                  callbacks: {
                    label: function(ctx) {
                      var p = ctx.raw;
                      var lines = [ctx.dataset.label + ': ' + p.y + '% accuracy, ' + p.x.toFixed(1) + 's/case'];
                      if (p.label) lines.push(p.label);
                      return lines;
                    }
                  }
                }
              },
              scales: {
                x: {
                  title: { display: true, text: 'avg duration per case (s)', color: '#71717a', font: { family: 'ui-monospace, monospace', size: 11 } },
                  ticks: { color: '#71717a', font: { family: 'ui-monospace, monospace', size: 10 } },
                  grid: { color: '#27272a' }
                },
                y: {
                  min: 0, max: 100,
                  title: { display: true, text: 'accuracy (%)', color: '#71717a', font: { family: 'ui-monospace, monospace', size: 11 } },
                  ticks: { color: '#71717a', font: { family: 'ui-monospace, monospace', size: 10 }, callback: function(v) { return v + '%'; } },
                  grid: { color: '#27272a' }
                }
              }
            },
            plugins: [{
              id: 'quadrantLines',
              afterDraw: function(chart) {
                var ctx = chart.ctx;
                var area = chart.chartArea;
                var xScale = chart.scales.x;
                var yScale = chart.scales.y;
                var midXPx = xScale.getPixelForValue(${midX});
                var midYPx = yScale.getPixelForValue(50);

                ctx.save();
                ctx.setLineDash([6, 4]);
                ctx.lineWidth = 1;
                ctx.strokeStyle = 'rgba(113, 113, 122, 0.4)';

                ctx.beginPath();
                ctx.moveTo(midXPx, area.top);
                ctx.lineTo(midXPx, area.bottom);
                ctx.stroke();

                ctx.beginPath();
                ctx.moveTo(area.left, midYPx);
                ctx.lineTo(area.right, midYPx);
                ctx.stroke();

                ctx.setLineDash([]);
                ctx.font = '10px ui-monospace, monospace';
                ctx.fillStyle = 'rgba(113, 113, 122, 0.5)';

                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';
                ctx.fillText('Ideal', area.left + 8, area.top + 8);

                ctx.textAlign = 'right';
                ctx.fillText('Smart but slow', area.right - 8, area.top + 8);

                ctx.textBaseline = 'bottom';
                ctx.fillText('Dumb and slow', area.right - 8, area.bottom - 8);

                ctx.textAlign = 'left';
                ctx.fillText('Dumb and fast', area.left + 8, area.bottom - 8);

                ctx.restore();
              }
            }]
          });
          window.__agestCharts['${canvasId}'] = chart;
        })();
      </script>
    </div>`;
}

function renderSingleRun(report: ParsedReport): string {
  const pct = (report.successRate * 100).toFixed(0);
  const passed = report.totalCases - report.failedCasesCount;
  const color = rateClass(report.successRate);
  const dur = formatDuration(report.duration);

  const failedRows = report.failedCases
    .map(
      (fc) => `
      <tr class="border-t border-zinc-800/50">
        <td class="py-2 pr-4 text-zinc-300 text-xs">${escHtml(fc.prompt)}</td>
        <td class="py-2 text-zinc-500 text-xs">${escHtml(fc.reason ?? "")}</td>
      </tr>`
    )
    .join("");

  const failedSection =
    report.failedCases.length > 0
      ? `
    <div class="mt-6">
      <h4 class="text-xs text-zinc-500 uppercase tracking-widest mb-2">Failed Cases</h4>
      <table class="w-full text-left">
        <thead><tr class="text-zinc-600 text-xs">
          <th class="pb-1 pr-4">Prompt</th>
          <th class="pb-1">Reason</th>
        </tr></thead>
        <tbody>${failedRows}</tbody>
      </table>
    </div>`
      : "";

  return `
    <div class="bg-zinc-900/50 rounded-lg border border-zinc-800 p-6">
      <div class="flex items-baseline gap-6 mb-4">
        <span class="${color} text-3xl font-bold">${pct}%</span>
        <span class="text-zinc-500 text-sm">${passed}/${report.totalCases} passed</span>
        <span class="text-zinc-600 text-sm">${dur}</span>
      </div>

      <div class="grid grid-cols-2 gap-4 text-sm">
        <div>
          <span class="text-zinc-500">Model</span>
          <p class="text-zinc-300">${escHtml(report.model)}</p>
        </div>
        <div>
          <span class="text-zinc-500">Timestamp</span>
          <p class="text-zinc-300">${formatTimestamp(report.timestamp)}</p>
        </div>
        ${
          report.averageInputTokensPerCase != null
            ? `<div>
          <span class="text-zinc-500">Avg Input Tokens</span>
          <p class="text-zinc-300">${Math.round(report.averageInputTokensPerCase)}</p>
        </div>`
            : ""
        }
        ${
          report.averageOutputTokensPerCase != null
            ? `<div>
          <span class="text-zinc-500">Avg Output Tokens</span>
          <p class="text-zinc-300">${Math.round(report.averageOutputTokensPerCase)}</p>
        </div>`
            : ""
        }
        ${
          report.tools && report.tools.length > 0
            ? `<div>
          <span class="text-zinc-500">Tools</span>
          <p class="text-zinc-300">${escHtml(report.tools.join(", "))}</p>
        </div>`
            : ""
        }
      </div>
      ${failedSection}
    </div>`;
}

function renderDebugPanel(group: AgentGroup): string {
  // Collect all failed cases across all runs, with dimension context
  const failures: Array<{
    prompt: string;
    reason?: string;
    response?: string;
    suite?: string;
    dims: string;
  }> = [];

  for (const run of group.runs) {
    const r = run.report;
    const dimTags = Object.entries(r.dimensions ?? {})
      .map(([k, v]) => {
        const short = v.length > 20 ? v.slice(0, 19) + "…" : v;
        return `${k}:${short}`;
      })
      .join(" ");

    // Top-level failed cases
    for (const fc of r.failedCases) {
      failures.push({ prompt: fc.prompt, reason: fc.reason, response: fc.response, dims: dimTags });
    }

    // Suite-level failed cases (may overlap with top-level, dedupe by prompt+dims)
    if (r.suites) {
      for (const s of r.suites) {
        for (const fc of s.failedCases) {
          const alreadyAdded = failures.some((f) => f.prompt === fc.prompt && f.dims === dimTags);
          if (!alreadyAdded) {
            failures.push({ prompt: fc.prompt, reason: fc.reason, response: fc.response, suite: s.name, dims: dimTags });
          } else {
            // Enrich existing entry with suite name
            const existing = failures.find((f) => f.prompt === fc.prompt && f.dims === dimTags);
            if (existing && !existing.suite) existing.suite = s.name;
            // Enrich with response if missing at top-level
            if (existing && !existing.response && fc.response) existing.response = fc.response;
          }
        }
      }
    }
  }

  if (failures.length === 0) return "";

  // Group by suite
  const suiteOrder: string[] = [];
  const bySuite = new Map<string, typeof failures>();
  for (const f of failures) {
    const key = f.suite ?? "__none__";
    if (!bySuite.has(key)) {
      suiteOrder.push(key);
      bySuite.set(key, []);
    }
    bySuite.get(key)!.push(f);
  }

  const renderFailure = (f: typeof failures[0]) => {
    const promptShort = f.prompt.length > 70 ? f.prompt.slice(0, 67) + "…" : f.prompt;
    const reasonShort = f.reason
      ? `<span class="text-red-400/60 text-[10px] ml-2">${escHtml(f.reason.length > 50 ? f.reason.slice(0, 47) + "…" : f.reason)}</span>`
      : "";

    const responseHtml = f.response
      ? escHtml(f.response).replace(/\n/g, "<br>")
      : `<span class="text-zinc-700">no response captured</span>`;

    return `
      <details class="border-t border-zinc-800/50">
        <summary class="py-2.5 cursor-pointer select-none hover:bg-zinc-800/30 rounded px-2 -mx-2 flex items-center gap-2">
          <span class="text-red-400 text-xs shrink-0">FAIL</span>
          <span class="text-xs text-zinc-300 truncate flex-1">${escHtml(promptShort)}</span>
          ${reasonShort}
          <span class="text-[10px] text-zinc-700">${escHtml(f.dims)}</span>
        </summary>
        <div class="pb-3 px-2 -mx-2 space-y-2">
          <div>
            <div class="text-[10px] text-zinc-600 uppercase mb-1">Input</div>
            <div class="text-xs text-zinc-300 bg-zinc-800/50 rounded px-3 py-2">${escHtml(f.prompt)}</div>
          </div>
          <div>
            <div class="text-[10px] text-zinc-600 uppercase mb-1">Output</div>
            <div class="text-xs text-zinc-400 bg-zinc-800/50 rounded px-3 py-2 max-h-48 overflow-y-auto">${responseHtml}</div>
          </div>
          ${f.reason ? `<div><div class="text-[10px] text-zinc-600 uppercase mb-1">Reason</div><div class="text-xs text-red-400/80">${escHtml(f.reason)}</div></div>` : ""}
        </div>
      </details>`;
  };

  const rows = suiteOrder.map((key) => {
    const items = bySuite.get(key)!;
    const label = key === "__none__" ? "no suite" : key;
    return `
      <div class="mb-3 last:mb-0">
        <div class="flex items-center gap-2 mb-1">
          <span class="text-[10px] text-zinc-500 uppercase tracking-wider font-medium">${escHtml(label)}</span>
          <span class="text-[10px] text-zinc-700">${items.length}</span>
        </div>
        <div class="pl-2 border-l border-zinc-800">
          ${items.map(renderFailure).join("")}
        </div>
      </div>`;
  }).join("");

  return `
    <div class="rounded-xl border border-zinc-800 bg-zinc-900 p-5 mb-4">
      <div class="flex items-center justify-between mb-4">
        <span class="text-xs text-zinc-600 uppercase tracking-wider">failed cases</span>
        <span class="text-xs text-zinc-600">${failures.length} failure${failures.length !== 1 ? "s" : ""}</span>
      </div>
      <div>
        ${rows}
      </div>
    </div>`;
}

function renderAgentSection(group: AgentGroup): string {
  const radarHtml = renderRadarChart(group);
  const chartHtml = renderGroupedBarChart(group);
  const scatterHtml = renderScatterPlot(group);
  const debugHtml = renderDebugPanel(group);

  // When there are no comparative charts, show a single-run summary card
  const singleRunHtml =
    !chartHtml && !scatterHtml && !radarHtml && group.runs.length > 0
      ? renderSingleRun(group.runs[0].report)
      : "";

  return `
  <section class="mb-12">
    <h2 class="text-base font-semibold mb-4 text-zinc-400 uppercase tracking-widest">${escHtml(group.label)}</h2>

    ${chartHtml}
    ${scatterHtml}
    ${radarHtml}
    ${singleRunHtml}
    ${debugHtml}
  </section>`;
}

// ---------------------------------------------------------------------------
// Full HTML page
// ---------------------------------------------------------------------------

function generateHTML(groups: AgentGroup[], totalReports: number): string {
  const sections = groups.map((g) => renderAgentSection(g)).join("\n");
  const generated = new Date().toLocaleString();

  return `<!DOCTYPE html>
<html lang="en" class="bg-zinc-950 text-zinc-100">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>agest preview</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    window.__agestCharts = {};
    window.__agestWilson = false;

    function toggleWilson() {
      window.__agestWilson = !window.__agestWilson;
      var useWilson = window.__agestWilson;
      var btn = document.getElementById('wilson-toggle');
      if (btn) {
        btn.className = useWilson
          ? 'px-3 py-1 text-xs rounded-full border transition-colors bg-violet-600 border-violet-500 text-violet-100'
          : 'px-3 py-1 text-xs rounded-full border transition-colors bg-zinc-800/50 border-zinc-700 text-zinc-500 hover:text-zinc-300';
        btn.textContent = useWilson ? 'Wilson CI (95%)' : 'Raw';
      }
      // Update all Chart.js instances
      Object.values(window.__agestCharts).forEach(function(chart) {
        chart.data.datasets.forEach(function(ds) {
          if (ds._rawData && ds._wilsonData) {
            ds.data = useWilson ? ds._wilsonData : ds._rawData;
          }
          // Scatter plot: swap y values
          if (ds._rawScatter && ds._wilsonScatter) {
            ds.data = useWilson ? ds._wilsonScatter : ds._rawScatter;
          }
        });
        chart.update();
      });
      // Update matrix view cells
      document.querySelectorAll('[data-wilson]').forEach(function(el) {
        el.textContent = useWilson ? el.getAttribute('data-wilson') : el.getAttribute('data-raw');
      });
    }

    function switchView(agent, dim) {
      var barEl = document.querySelector('.bar-view[data-agent="' + agent + '"][data-dim="' + dim + '"]');
      var tableEl = document.querySelector('.table-view[data-agent="' + agent + '"][data-dim="' + dim + '"]');
      var btn = document.querySelector('.view-toggle[data-agent="' + agent + '"][data-dim="' + dim + '"]');
      if (!barEl || !tableEl || !btn) return;
      var showingTable = tableEl.style.display !== 'none';
      barEl.style.display = showingTable ? 'block' : 'none';
      tableEl.style.display = showingTable ? 'none' : 'block';
      btn.textContent = showingTable ? 'Table' : 'Chart';
    }

    function switchDim(agent, dim) {
      document.querySelectorAll('.chart-view[data-agent="' + agent + '"]').forEach(el => {
        el.style.display = el.dataset.dim === dim ? 'block' : 'none';
      });
    }
    function filterRadarModel(agent, model) {
      document.querySelectorAll('.radar-model-view[data-agent="' + agent + '"]').forEach(el => {
        el.style.display = el.dataset.model === model ? 'block' : 'none';
      });
    }
  </script>
</head>
<body class="min-h-screen font-mono p-8">
  <div class="max-w-4xl mx-auto">

    <header class="mb-10">
      <h1 class="text-2xl font-bold tracking-tight">agest</h1>
      <div class="flex items-center gap-3 mt-1">
        <p class="text-zinc-500 text-sm">${totalReports} report${totalReports !== 1 ? "s" : ""} &middot; generated ${generated}</p>
        <button id="wilson-toggle" onclick="toggleWilson()" title="Wilson score lower bound (95% CI) — adjusts for sample size"
          class="px-3 py-1 text-xs rounded-full border transition-colors bg-zinc-800/50 border-zinc-700 text-zinc-500 hover:text-zinc-300">Raw</button>
      </div>
    </header>

    ${sections}

    <footer class="mt-16 border-t border-zinc-800 pt-6 text-xs text-zinc-600">
      agest by <a href="https://sebastiantuyu.com" target="_blank" class="text-zinc-500 hover:text-zinc-300 transition-colors">sebastiantuyu</a>
    </footer>

  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cwd = process.cwd();
  const files = await findReports(cwd);

  if (files.length === 0) {
    console.log("\n  No reports found. Run some agent tests first.\n");
    return;
  }

  const reports = await Promise.all(
    files.map(async (f) => {
      const content = await readFile(f, "utf-8");
      return parseReport(content, relative(cwd, f));
    })
  );

  // Ensure all reports have dimensions (backward compat)
  await Promise.all(reports.map((r) => ensureDimensions(r)));

  // Group by agent name, sort each group oldest -> newest
  const groupMap = new Map<string, ParsedReport[]>();
  for (const r of reports) {
    const key = r.name ?? "__unnamed__";
    const arr = groupMap.get(key) ?? [];
    arr.push(r);
    groupMap.set(key, arr);
  }
  for (const [, arr] of groupMap) {
    arr.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  // Build AgentGroups with dimension analysis
  const namedKeys = [...groupMap.keys()]
    .filter((k) => k !== "__unnamed__")
    .sort();
  const orderedKeys = groupMap.has("__unnamed__")
    ? [...namedKeys, "__unnamed__"]
    : namedKeys;

  const groups: AgentGroup[] = await Promise.all(
    orderedKeys.map(async (key) => {
      const sorted = groupMap.get(key)!;
      const varyingDims = findVaryingDimensions(sorted);
      const controlledPairs = findControlledPairs(sorted);

      // Load diff entries for consecutive run diffs
      const diffEntries = await Promise.all(
        sorted.map((r) =>
          r.systemPromptHash ? loadDiffEntry(r.systemPromptHash) : Promise.resolve(null)
        )
      );

      const runs: RunEntry[] = sorted.map((report, i) => {
        const delta =
          i === 0
            ? undefined
            : (report.successRate - sorted[i - 1].successRate) * 100;

        let diffLines: string[] = [];
        if (i > 0) {
          const prev = diffEntries[i - 1];
          const curr = diffEntries[i];
          if (prev && curr) {
            diffLines = computeDiff(prev, curr);
          }
        }

        return { report, delta, diffLines };
      });

      return {
        label: key === "__unnamed__" ? "Unnamed" : key,
        runs,
        varyingDims,
        controlledPairs,
        diffEntries,
      };
    })
  );

  const html = generateHTML(groups, reports.length);
  const tmpPath = join(os.tmpdir(), `agest-preview-${Date.now()}.html`);
  await writeFile(tmpPath, html, "utf-8");

  console.log(`\n  Preview: ${tmpPath}\n`);
  openBrowser(tmpPath);
}

export { main };
