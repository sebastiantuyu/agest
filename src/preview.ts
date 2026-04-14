import { readFile, writeFile } from "fs/promises";
import { join, relative } from "path";
import os from "os";
import { exec } from "child_process";
import {
  type ParsedReport,
  type ControlledComparison,
  parseReport,
  findReports,
  loadDiffEntry,
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
  agentId: string,
  isActive: boolean,
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
          const color = barColor(r.successRate);
          const tc = rateClass(r.successRate);
          return `<td class="px-4 py-2">
            <div class="flex items-center gap-3">
              <div class="flex-1 bg-zinc-800 rounded h-2 overflow-hidden" style="min-width:80px">
                <div class="h-2 rounded" style="width:${pct.toFixed(1)}%;background:${color}"></div>
              </div>
              <span class="text-sm font-medium ${tc} w-12 text-right">${pct.toFixed(0)}%</span>
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

  return `<div class="chart-view" data-agent="${agentId}" data-dim="${escHtml(groupDim)}" style="display:${isActive ? "block" : "none"}">
    <div class="mb-4">
      <div class="text-xs text-zinc-600 uppercase tracking-wider mb-1">grouped by ${escHtml(groupDim)}</div>
    </div>
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
    </div>
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

  // Build version labels for each dimension: first unique value seen = v1, etc.
  const versionMaps = new Map<string, Map<string, string>>();
  const sorted = [...reports].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  for (const dim of allDims) {
    const seen = new Map<string, string>();
    let idx = 1;
    for (const r of sorted) {
      const val = r.dimensions?.[dim] ?? "?";
      if (!seen.has(val)) {
        seen.set(val, `v${idx}`);
        idx++;
      }
    }
    versionMaps.set(dim, seen);
  }

  const dimLabel = (dim: string, val: string): string => {
    const vMap = versionMaps.get(dim);
    const version = vMap?.get(val) ?? "?";
    // For model, show short model name. For others, show version tag.
    if (dim === "model") {
      const short = val.length > 16 ? val.split("/").pop()?.slice(0, 16) ?? val.slice(0, 16) : val;
      return short;
    }
    // For tools, show "none" directly instead of a version tag
    if (dim === "tools" && val === "none") {
      return "none";
    }
    return version;
  };

  // Build a chart for each possible grouping dimension
  const charts = varying.map((groupDim, dimIdx) => {
    const isActive = dimIdx === 0;

    // For non-model dimensions, render a matrix/heatmap view instead of bar chart
    if (groupDim !== "model") {
      return renderMatrixView(sorted, groupDim, allDims, versionMaps, dimLabel, agentId, isActive);
    }

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

      const data = groupVals.map((gv) => {
        const groupRuns = grouped.get(gv) ?? [];
        const match = groupRuns.find((r) => configKey(r) === ck);
        return match ? +(match.successRate * 100).toFixed(1) : null;
      });

      return { label: cfgLabel, data, backgroundColor: color.bg, borderColor: color.bg, borderWidth: 0, borderRadius: 4 };
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

    return `<div class="chart-view" data-agent="${agentId}" data-dim="${escHtml(groupDim)}" style="display:${isActive ? "block" : "none"}">
      <div class="mb-4">
        <div class="text-xs text-zinc-600 uppercase tracking-wider mb-1">grouped by ${escHtml(groupDim)}</div>
      </div>
      <div style="position:relative;height:280px">
        <canvas id="${canvasId}"></canvas>
      </div>
      <script>
        new Chart(document.getElementById('${canvasId}'), {
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
      </script>
      <div class="mt-4 pt-3 border-t border-zinc-800/50 space-y-1">
        ${versionRef}
      </div>
    </div>`;
  });

  // Dimension toggle tabs
  const tabs = varying
    .map((dim, i) => {
      const active = i === 0;
      return `<button
        class="dim-tab px-3 py-1.5 text-xs rounded-md transition-colors ${active ? "bg-zinc-700 text-zinc-200" : "bg-zinc-800/50 text-zinc-500 hover:text-zinc-300"}"
        data-agent="${agentId}"
        data-dim="${escHtml(dim)}"
        onclick="switchDim('${agentId}', '${escHtml(dim)}')"
      >${escHtml(dim)}</button>`;
    })
    .join("\n");

  return `
    <div class="rounded-xl border border-zinc-800 bg-zinc-900 p-5 mb-4">
      <div class="flex items-center justify-between mb-5">
        <span class="text-xs text-zinc-600 uppercase tracking-wider">success rate</span>
        <div class="flex gap-1.5">
          ${tabs}
        </div>
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
  const byModel = new Map<string, Array<{ x: number; y: number; label: string }>>();
  for (const r of reports) {
    const model = r.dimensions?.["model"] ?? r.model ?? "?";
    const avgDurSec = r.totalCases > 0 ? +(r.duration / r.totalCases / 1000).toFixed(2) : 0;
    const accuracy = +(r.successRate * 100).toFixed(1);
    const configLabel = allDims
      .filter((d) => d !== "model")
      .map((d) => `${d}: ${r.dimensions?.[d] ?? "?"}`)
      .join(", ");

    const arr = byModel.get(model) ?? [];
    arr.push({ x: avgDurSec, y: accuracy, label: configLabel });
    byModel.set(model, arr);
  }

  const uniqueModels = [...byModel.keys()];
  const datasets = uniqueModels.map((model, i) => {
    const color = SERIES_COLORS[i % SERIES_COLORS.length];
    const short = model.split("/").pop()?.slice(0, 24) ?? model.slice(0, 24);
    return {
      label: short,
      data: byModel.get(model)!,
      backgroundColor: color.bg,
      borderColor: color.text,
      pointRadius: 7,
      pointHoverRadius: 9,
    };
  });

  const allX = [...byModel.values()].flat().map((p) => p.x);
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
        new Chart(document.getElementById('${canvasId}'), {
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

function renderAgentSection(group: AgentGroup): string {
  const chartHtml = renderGroupedBarChart(group);
  const scatterHtml = renderScatterPlot(group);

  // When there are no comparative charts, show a single-run summary card
  const singleRunHtml =
    !chartHtml && !scatterHtml && group.runs.length > 0
      ? renderSingleRun(group.runs[0].report)
      : "";

  return `
  <section class="mb-12">
    <h2 class="text-base font-semibold mb-4 text-zinc-400 uppercase tracking-widest">${escHtml(group.label)}</h2>

    ${chartHtml}
    ${scatterHtml}
    ${singleRunHtml}
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
    function switchDim(agent, dim) {
      document.querySelectorAll('.chart-view[data-agent="' + agent + '"]').forEach(el => {
        el.style.display = el.dataset.dim === dim ? 'block' : 'none';
      });
      document.querySelectorAll('.dim-tab[data-agent="' + agent + '"]').forEach(el => {
        if (el.dataset.dim === dim) {
          el.className = el.className.replace('bg-zinc-800/50 text-zinc-500', 'bg-zinc-700 text-zinc-200');
        } else {
          el.className = el.className.replace('bg-zinc-700 text-zinc-200', 'bg-zinc-800/50 text-zinc-500');
        }
      });
    }
  </script>
</head>
<body class="min-h-screen font-mono p-8">
  <div class="max-w-4xl mx-auto">

    <header class="mb-10">
      <h1 class="text-2xl font-bold tracking-tight">agest</h1>
      <p class="text-zinc-500 text-sm mt-1">${totalReports} report${totalReports !== 1 ? "s" : ""} &middot; generated ${generated}</p>
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
