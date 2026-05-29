import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  isStandardSchema,
  formatIssues,
  validateSync,
  validateAgainstSchema,
  type StandardSchemaV1,
} from "./schema";

const Plan = z.object({
  plan_items: z.array(z.object({ step: z.string() })),
});

describe("isStandardSchema", () => {
  it("recognises a zod schema", () => {
    expect(isStandardSchema(Plan)).toBe(true);
    expect(isStandardSchema(z.string())).toBe(true);
  });

  it("rejects non-schemas", () => {
    expect(isStandardSchema(() => {})).toBe(false);
    expect(isStandardSchema({})).toBe(false);
    expect(isStandardSchema(null)).toBe(false);
    expect(isStandardSchema("nope")).toBe(false);
  });
});

describe("validateSync", () => {
  it("passes a conforming value", () => {
    const out = validateSync(Plan, { plan_items: [{ step: "search" }] });
    expect(out.ok).toBe(true);
  });

  it("fails a non-conforming value with formatted issues", () => {
    const out = validateSync(Plan, { plan_items: [{ step: 42 }] });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toContain("plan_items.0.step");
      expect(out.message).toMatch(/issue/);
    }
  });

  it("throws a directive error for an async schema", () => {
    const asyncSchema = z.string().refine(async () => true);
    expect(() => validateSync(asyncSchema, "x")).toThrow(/async schema/i);
  });
});

describe("validateAgainstSchema", () => {
  it("passes a conforming value", async () => {
    const out = await validateAgainstSchema(z.number(), 7);
    expect(out.ok).toBe(true);
  });

  it("fails a non-conforming value", async () => {
    const out = await validateAgainstSchema(z.number(), "seven");
    expect(out.ok).toBe(false);
  });

  it("awaits async schemas", async () => {
    const asyncSchema = z.string().refine(async (v) => v === "ok", "must be ok");
    expect((await validateAgainstSchema(asyncSchema, "ok")).ok).toBe(true);
    const bad = await validateAgainstSchema(asyncSchema, "no");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain("must be ok");
  });
});

describe("formatIssues", () => {
  it("renders nested paths joined by dots", () => {
    const issues: StandardSchemaV1.Issue[] = [
      { message: "Expected string", path: ["plan_items", 0, { key: "step" }] },
      { message: "Required" },
    ];
    const msg = formatIssues(issues);
    expect(msg).toContain("2 issues:");
    expect(msg).toContain("plan_items.0.step: Expected string");
    expect(msg).toContain("• Required");
  });

  it("uses singular wording for one issue", () => {
    expect(formatIssues([{ message: "nope" }])).toContain("1 issue:");
  });
});
