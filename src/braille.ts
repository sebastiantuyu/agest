/**
 * Dependency-free Braille "pixel canvas" for terminal vector graphics. Each
 * Unicode Braille glyph (U+2800..U+28FF) packs a 2×4 dot grid, giving ~8× the
 * resolution of plain ASCII. Ported from the self-contained renderer in
 * example.html (no `drawille` package needed).
 *
 * Used to draw the capability-area radar in `agest coverage --radar`.
 */

const PMAP = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

export class Braille {
  readonly w: number;
  readonly h: number;
  readonly cols: number;
  readonly rows: number;
  private grid: Uint8Array;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.cols = Math.ceil(w / 2);
    this.rows = Math.ceil(h / 4);
    this.grid = new Uint8Array(this.cols * this.rows);
  }

  clear(): void {
    this.grid.fill(0);
  }

  set(x: number, y: number): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const c = x >> 1;
    const r = y >> 2;
    this.grid[r * this.cols + c] |= PMAP[y & 3][x & 1];
  }

  /** Raw braille bits for a cell (0 = blank) — used by the per-cell compositor. */
  cell(c: number, r: number): number {
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return 0;
    return this.grid[r * this.cols + c];
  }

  dot(x: number, y: number, rad = 0): void {
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++)
        if (dx * dx + dy * dy <= rad * rad + 1) this.set(x + dx, y + dy);
  }

  line(x0: number, y0: number, x1: number, y1: number): void {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      this.set(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x0 += sx;
      }
      if (e2 < dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  polygon(pts: Array<[number, number]>, close: boolean): void {
    for (let i = 0; i < pts.length - 1; i++)
      this.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (close && pts.length > 1)
      this.line(pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1]);
  }

  /** Dithered scanline fill (50% density via checkerboard). */
  fillPoly(pts: Array<[number, number]>, dither: boolean): void {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
    minY = Math.max(0, Math.floor(minY));
    maxY = Math.min(this.h - 1, Math.ceil(maxY));
    for (let y = minY; y <= maxY; y++) {
      const xs: number[] = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const yi = pts[i][1];
        const yj = pts[j][1];
        if (yi > y !== yj > y) {
          xs.push(pts[i][0] + ((y - yi) / (yj - yi)) * (pts[j][0] - pts[i][0]));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.ceil(xs[k]); x <= Math.floor(xs[k + 1]); x++) {
          if (!dither || ((x + y) & 1) === 0) this.set(x, y);
        }
      }
    }
  }

  glyph(bits: number): string {
    return bits === 0 ? " " : String.fromCharCode(0x2800 | bits);
  }

  text(): string {
    let out = "";
    for (let r = 0; r < this.rows; r++) {
      let line = "";
      for (let c = 0; c < this.cols; c++) line += this.glyph(this.grid[r * this.cols + c]);
      out += line + (r < this.rows - 1 ? "\n" : "");
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Radar chart
// ---------------------------------------------------------------------------

export interface RadarAxis {
  label: string;
  /** 0..1 — the spoke fraction (e.g. pass rate). */
  value: number;
  /** Optional short suffix after the label (e.g. "80%"). */
  note?: string;
}

export interface RadarOptions {
  /** Pixel canvas size (square). Default 116 → ~58×29 glyphs. */
  size?: number;
  /** Vertical aspect compensation; terminal braille is ~square so ~1.0. */
  ky?: number;
  /** Dithered polygon fill. Off by default for a cleaner outline. */
  fill?: boolean;
  /** Emit ANSI colors. */
  color?: boolean;
}

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const COL = {
  grid: `${ESC}2;32m`, // dim green phosphor
  data: `${ESC}93m`, // bright amber/yellow
  label: `${ESC}1;32m`, // bold green
  note: `${ESC}2;33m`, // dim amber
};

/**
 * Render a radar/spider chart as colored multi-line terminal text. Needs ≥3
 * axes. Grid (rings + spokes) and the data polygon are drawn on separate
 * Braille canvases, then merged per glyph-cell (data wins) and overlaid with
 * axis labels stamped into the character grid.
 */
export function renderRadar(axes: RadarAxis[], opts: RadarOptions = {}): string {
  const N = axes.length;
  if (N < 3) return "";
  const size = opts.size ?? 116;
  const ky = opts.ky ?? 1.0;
  const fill = opts.fill ?? false;
  const color = opts.color ?? true;

  const W = size;
  const H = size;
  const CX = W / 2;
  const CY = H / 2;
  const R = Math.min(CX, CY / ky) * 0.78;
  const RINGS = [0.25, 0.5, 0.75, 1];

  const angle = (i: number) => ((-90 + (i * 360) / N) * Math.PI) / 180;
  const point = (frac: number, i: number): [number, number] => [
    CX + Math.cos(angle(i)) * R * frac,
    CY + Math.sin(angle(i)) * R * frac * ky,
  ];

  const grid = new Braille(W, H);
  const data = new Braille(W, H);

  for (const f of RINGS) {
    const ring: Array<[number, number]> = [];
    for (let i = 0; i < N; i++) ring.push(point(f, i));
    grid.polygon(ring, true);
  }
  for (let i = 0; i < N; i++) {
    const [ex, ey] = point(1, i);
    grid.line(CX, CY, ex, ey);
  }

  const pts = axes.map((a, i) => point(Math.max(0, Math.min(1, a.value)), i));
  if (fill) data.fillPoly(pts, true);
  data.polygon(pts, true);
  for (const [x, y] of pts) data.dot(x, y, 1);

  // Compose into a char/color matrix with horizontal padding for labels.
  const labelText = axes.map((a) => (a.note ? `${a.label} ${a.note}` : a.label));
  const pad = Math.max(...labelText.map((t) => t.length)) + 1;
  const width = grid.cols + pad * 2;
  const chars: string[][] = [];
  const colors: (string | null)[][] = [];
  for (let r = 0; r < grid.rows; r++) {
    chars.push(new Array(width).fill(" "));
    colors.push(new Array(width).fill(null));
  }

  // Merge braille cells — data layer on top of the grid layer.
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const d = data.cell(c, r);
      const g = grid.cell(c, r);
      if (d) {
        chars[r][c + pad] = data.glyph(d);
        colors[r][c + pad] = COL.data;
      } else if (g) {
        chars[r][c + pad] = grid.glyph(g);
        colors[r][c + pad] = COL.grid;
      }
    }
  }

  // Stamp axis labels into the grid at each spoke endpoint.
  for (let i = 0; i < N; i++) {
    const [lx, ly] = point(1.06, i);
    const co = Math.cos(angle(i));
    const row = Math.max(0, Math.min(grid.rows - 1, Math.round(ly / 4)));
    const anchorCol = Math.round(lx / 2) + pad;
    const text = labelText[i];
    let start: number;
    if (co > 0.2) start = anchorCol + 1; // right side → left-align
    else if (co < -0.2) start = anchorCol - text.length - 1; // left side → right-align
    else start = anchorCol - Math.floor(text.length / 2); // top/bottom → center
    for (let k = 0; k < text.length; k++) {
      const c = start + k;
      if (c < 0 || c >= width) continue;
      chars[row][c] = text[k];
      // Color the label name green, the trailing note dim amber.
      const noteAt = axes[i].note ? axes[i].label.length + 1 : Infinity;
      colors[row][c] = k >= noteAt ? COL.note : COL.label;
    }
  }

  // Emit, collapsing runs of the same color and trimming trailing blanks.
  const lines: string[] = [];
  for (let r = 0; r < grid.rows; r++) {
    let line = "";
    let cur: string | null = null;
    let lastNonBlank = -1;
    for (let c = width - 1; c >= 0; c--) {
      if (chars[r][c] !== " ") {
        lastNonBlank = c;
        break;
      }
    }
    for (let c = 0; c <= lastNonBlank; c++) {
      const wantColor = color ? colors[r][c] : null;
      if (wantColor !== cur) {
        if (cur) line += RESET;
        if (wantColor) line += wantColor;
        cur = wantColor;
      }
      line += chars[r][c];
    }
    if (cur) line += RESET;
    lines.push(line);
  }
  // Trim fully-blank leading/trailing rows (the radar never fills the square
  // canvas corners) so it doesn't waste vertical space.
  const blank = (s: string) => s.trim() === "";
  while (lines.length && blank(lines[0])) lines.shift();
  while (lines.length && blank(lines[lines.length - 1])) lines.pop();
  return lines.join("\n");
}
