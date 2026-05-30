import type { TimelineEvent } from "./types";
import { c } from "./logger";

const BLOCK = "█";
const THIN = "▏";

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  return "$" + Number(n.toFixed(4)).toString();
}

/**
 * Render a Chrome-DevTools-style waterfall of timeline events as colored
 * terminal lines. Bars are positioned by `startMs` and sized by `durationMs`
 * relative to the full span of the scene. Returns one string per event row
 * (already indented), or `[]` when there's nothing to draw.
 */
export function renderTerminalWaterfall(
  events: TimelineEvent[],
  opts: { width?: number; indent?: string } = {}
): string[] {
  if (!events || events.length === 0) return [];
  const width = opts.width ?? 28;
  const indent = opts.indent ?? "";

  const t0 = Math.min(...events.map((e) => e.startMs));
  const tEnd = Math.max(...events.map((e) => e.endMs));
  const span = Math.max(1, tEnd - t0);

  const nameWidth = 16;

  return events.map((e) => {
    const lead = Math.min(width - 1, Math.round(((e.startMs - t0) / span) * width));
    const barLen = Math.max(1, Math.round((e.durationMs / span) * width));
    const fill = e.durationMs === 0 ? THIN : BLOCK.repeat(Math.min(barLen, width - lead));

    const cells = Array(width).fill(" ");
    for (let i = 0; i < fill.length && lead + i < width; i++) {
      cells[lead + i] = fill[i];
    }
    let bar = cells.join("");

    const color = e.error ? c.red : e.kind === "model" ? c.cyan : c.yellow;
    bar = color(bar);

    const kindLabel = (e.kind === "model" ? "model" : "tool ").padEnd(5);
    const nameLabel = truncate(e.name, nameWidth).padEnd(nameWidth);
    const dur = `${Math.round(e.durationMs)}ms`.padStart(7);
    const cost = e.cost?.totalUsd != null ? `  ${fmtUsd(e.cost.totalUsd)}` : "";
    const cached = e.cachedInputTokens ? `  ${c.dim(`(${e.cachedInputTokens} cached)`)}` : "";
    const err = e.error ? `  ${c.red("✗ " + truncate(e.error, 40))}` : "";

    return `${indent}${c.dim(kindLabel)} ${nameLabel} ${bar} ${c.dim(dur)}${c.dim(cost)}${cached}${err}`;
  });
}
