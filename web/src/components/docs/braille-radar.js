(function () {
      const PMAP = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];

      class Braille {
        constructor(w, h) {
          this.w = w; this.h = h;
          this.cols = Math.ceil(w / 2); this.rows = Math.ceil(h / 4);
          this.grid = new Uint8Array(this.cols * this.rows);
        }
        set(x, y) {
          x = Math.round(x); y = Math.round(y);
          if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
          this.grid[(y >> 2) * this.cols + (x >> 1)] |= PMAP[y & 3][x & 1];
        }
        cell(c, r) {
          if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return 0;
          return this.grid[r * this.cols + c];
        }
        dot(x, y, rad = 0) {
          for (let dy = -rad; dy <= rad; dy++)
            for (let dx = -rad; dx <= rad; dx++)
              if (dx * dx + dy * dy <= rad * rad + 1) this.set(x + dx, y + dy);
        }
        line(x0, y0, x1, y1) {
          x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
          const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
          const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
          let err = dx - dy;
          for (; ;) {
            this.set(x0, y0);
            if (x0 === x1 && y0 === y1) break;
            const e2 = 2 * err;
            if (e2 > -dy) { err -= dy; x0 += sx; }
            if (e2 < dx) { err += dx; y0 += sy; }
          }
        }
        polygon(pts, close) {
          for (let i = 0; i < pts.length - 1; i++) this.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
          if (close && pts.length > 1) this.line(pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1]);
        }
        fillPoly(pts, dither) {
          let minY = Infinity, maxY = -Infinity;
          for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
          minY = Math.max(0, Math.floor(minY)); maxY = Math.min(this.h - 1, Math.ceil(maxY));
          for (let y = minY; y <= maxY; y++) {
            const xs = [];
            for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
              const yi = pts[i][1], yj = pts[j][1];
              if ((yi > y) !== (yj > y)) xs.push(pts[i][0] + ((y - yi) / (yj - yi)) * (pts[j][0] - pts[i][0]));
            }
            xs.sort((a, b) => a - b);
            for (let k = 0; k + 1 < xs.length; k += 2)
              for (let x = Math.ceil(xs[k]); x <= Math.floor(xs[k + 1]); x++)
                if (!dither || ((x + y) & 1) === 0) this.set(x, y);
          }
        }
        glyph(bits) { return bits === 0 ? ' ' : String.fromCharCode(0x2800 | bits); }
      }

      const PALETTE = { grid: 'var(--phos-grid)', data: 'var(--phos-data)', label: 'var(--phos-label)', note: 'var(--phos-note)' };
      const esc = (s) => s === '&' ? '&amp;' : s === '<' ? '&lt;' : s === '>' ? '&gt;' : s;

      function renderRadarHTML(axes, opts = {}) {
        const N = axes.length;
        if (N < 3) return '';
        const size = opts.size ?? 120, ky = opts.ky ?? 1.2, fill = opts.fill ?? true;
        const W = size, H = size, CX = W / 2, CY = H / 2;
        const R = Math.min(CX, CY / ky) * 0.78;
        const RINGS = [0.25, 0.5, 0.75, 1];
        const angle = (i) => ((-90 + (i * 360) / N) * Math.PI) / 180;
        const point = (frac, i) => [CX + Math.cos(angle(i)) * R * frac, CY + Math.sin(angle(i)) * R * frac * ky];

        const grid = new Braille(W, H), data = new Braille(W, H);
        for (const f of RINGS) { const ring = []; for (let i = 0; i < N; i++) ring.push(point(f, i)); grid.polygon(ring, true); }
        for (let i = 0; i < N; i++) { const [ex, ey] = point(1, i); grid.line(CX, CY, ex, ey); }

        const pts = axes.map((a, i) => point(Math.max(0, Math.min(1, a.value)), i));
        if (fill) data.fillPoly(pts, true);
        data.polygon(pts, true);
        for (const [x, y] of pts) data.dot(x, y, 1);

        const labelText = axes.map((a) => (a.note ? `${a.label} ${a.note}` : a.label));
        const pad = Math.max(...labelText.map((t) => t.length)) + 1;
        const width = grid.cols + pad * 2;
        const chars = [], colors = [];
        for (let r = 0; r < grid.rows; r++) { chars.push(new Array(width).fill(' ')); colors.push(new Array(width).fill(null)); }

        for (let r = 0; r < grid.rows; r++)
          for (let c = 0; c < grid.cols; c++) {
            const d = data.cell(c, r), g = grid.cell(c, r);
            if (d) { chars[r][c + pad] = data.glyph(d); colors[r][c + pad] = 'data'; }
            else if (g) { chars[r][c + pad] = grid.glyph(g); colors[r][c + pad] = 'grid'; }
          }

        for (let i = 0; i < N; i++) {
          const [lx, ly] = point(1.06, i);
          const co = Math.cos(angle(i));
          const row = Math.max(0, Math.min(grid.rows - 1, Math.round(ly / 4)));
          const anchorCol = Math.round(lx / 2) + pad;
          const text = labelText[i];
          let start;
          if (co > 0.2) start = anchorCol + 1;
          else if (co < -0.2) start = anchorCol - text.length - 1;
          else start = anchorCol - Math.floor(text.length / 2);
          const noteAt = axes[i].note ? axes[i].label.length + 1 : Infinity;
          for (let k = 0; k < text.length; k++) {
            const c = start + k;
            if (c < 0 || c >= width) continue;
            chars[row][c] = text[k];
            colors[row][c] = k >= noteAt ? 'note' : 'label';
          }
        }

        const lines = [];
        for (let r = 0; r < grid.rows; r++) {
          let line = '', cur = null, lastNonBlank = -1;
          for (let c = width - 1; c >= 0; c--) { if (chars[r][c] !== ' ') { lastNonBlank = c; break; } }
          for (let c = 0; c <= lastNonBlank; c++) {
            const wc = colors[r][c];
            if (wc !== cur) { if (cur) line += '</span>'; if (wc) line += `<span style="color:${PALETTE[wc]}">`; cur = wc; }
            line += esc(chars[r][c]);
          }
          if (cur) line += '</span>';
          lines.push(line);
        }
        const blank = (s) => s.replace(/<[^>]*>/g, '').trim() === '';
        while (lines.length && blank(lines[0])) lines.shift();
        while (lines.length && blank(lines[lines.length - 1])) lines.pop();
        return lines.join('\n');
      }

      const el = document.getElementById('braille-radar');
      if (el) {
        el.innerHTML = renderRadarHTML([
          { label: 'refusal', value: 1.00, note: '100%' },
          { label: 'correctness', value: 0.96, note: '96%' },
          { label: 'tool-use', value: 0.91, note: '91%' },
          { label: 'performance', value: 0.84, note: '84%' },
          { label: 'robustness', value: 0.80, note: '80%' },
          { label: 'memory', value: 0.88, note: '88%' },
          { label: 'format', value: 0.65, note: '65%' },
        ], { ky: 1.2, fill: true, size: 120 });
      }
    })();
