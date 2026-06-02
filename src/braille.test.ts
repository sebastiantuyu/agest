import { describe, it, expect } from "vitest";
import { Braille, renderRadar } from "./braille";

const isBraille = (s: string) => [...s].some((ch) => ch.charCodeAt(0) >= 0x2800 && ch.charCodeAt(0) <= 0x28ff);

describe("Braille canvas", () => {
  it("maps a single sub-pixel to the correct glyph", () => {
    const b = new Braille(2, 4);
    b.set(0, 0); // top-left dot → U+2801
    expect(b.text()).toBe(String.fromCharCode(0x2801));
  });

  it("emits a blank space for an empty cell", () => {
    expect(new Braille(2, 4).text()).toBe(" ");
  });

  it("draws a line as braille glyphs", () => {
    const b = new Braille(20, 8);
    b.line(0, 0, 19, 7);
    expect(isBraille(b.text())).toBe(true);
  });
});

describe("renderRadar", () => {
  it("returns empty string for fewer than 3 axes", () => {
    expect(renderRadar([{ label: "A", value: 1 }, { label: "B", value: 1 }])).toBe("");
  });

  it("renders braille glyphs and axis labels for >= 3 axes", () => {
    const out = renderRadar(
      [
        { label: "speed", value: 0.8, note: "80%" },
        { label: "power", value: 0.5 },
        { label: "range", value: 0.9 },
        { label: "agility", value: 0.3 },
      ],
      { color: false },
    );
    expect(isBraille(out)).toBe(true);
    expect(out).toContain("SPEED".toLowerCase().length > 0 ? "speed" : "");
    // labels are stamped verbatim from the axis labels (no forced upcasing here)
    expect(out).toContain("speed");
    expect(out).toContain("80%");
  });

  it("omits ANSI escapes when color is off", () => {
    const out = renderRadar(
      [
        { label: "a", value: 1 },
        { label: "b", value: 0.5 },
        { label: "c", value: 0 },
      ],
      { color: false },
    );
    expect(out).not.toContain("\x1b[");
  });
});
