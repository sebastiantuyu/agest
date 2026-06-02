import { describe, it, expect } from "vitest";
import type { AgentResponse } from "./types.js";
import { serializeValue, resolveValue, resolveText, navigatePath } from "./resolve.js";

describe("serializeValue", () => {
  it("passes strings through untouched", () => {
    expect(serializeValue("hello")).toBe("hello");
    expect(serializeValue("")).toBe("");
  });

  it("renders null and undefined as empty string", () => {
    expect(serializeValue(null)).toBe("");
    expect(serializeValue(undefined)).toBe("");
  });

  it("pretty-prints objects as 2-space JSON", () => {
    expect(serializeValue({ a: 1, b: [2, 3] })).toBe(
      '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}'
    );
  });

  it("serializes arrays", () => {
    expect(serializeValue([1, "two"])).toBe('[\n  1,\n  "two"\n]');
  });

  it("serializes numbers and booleans via JSON", () => {
    expect(serializeValue(42)).toBe("42");
    expect(serializeValue(false)).toBe("false");
  });

  it("falls back to String() when JSON.stringify throws (circular)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(serializeValue(circular)).toBe("[object Object]");
  });
});

describe("resolveValue", () => {
  it("returns the native value when present", () => {
    const res: AgentResponse<{ plan: string }> = { value: { plan: "x" } };
    expect(resolveValue(res)).toEqual({ plan: "x" });
  });

  it("falls back to text for a legacy text-only response", () => {
    const res: AgentResponse = { text: "legacy" };
    expect(resolveValue(res)).toBe("legacy");
  });

  it("prefers value over text when both are present", () => {
    const res: AgentResponse<{ n: number }> = { value: { n: 1 }, text: "ignored" };
    expect(resolveValue(res)).toEqual({ n: 1 });
  });

  it("preserves falsy native values rather than falling back to text", () => {
    const zero: AgentResponse<number> = { value: 0, text: "0-text" };
    expect(resolveValue(zero)).toBe(0);
    const emptyStr: AgentResponse = { value: "", text: "fallback" };
    expect(resolveValue(emptyStr)).toBe("");
    const falseVal: AgentResponse<boolean> = { value: false, text: "t" };
    expect(resolveValue(falseVal)).toBe(false);
  });

  it("returns undefined when neither value nor text is set", () => {
    expect(resolveValue({} as AgentResponse)).toBeUndefined();
  });
});

describe("resolveText", () => {
  it("returns an explicit text projection verbatim", () => {
    const res: AgentResponse<{ id: string }> = { value: { id: "u1" }, text: "Alice" };
    expect(resolveText(res)).toBe("Alice");
  });

  it("prefers an empty-string text over serializing value", () => {
    const res: AgentResponse<{ id: string }> = { value: { id: "u1" }, text: "" };
    expect(resolveText(res)).toBe("");
  });

  it("serializes value when text is omitted", () => {
    const res: AgentResponse<{ a: number }> = { value: { a: 1 } };
    expect(resolveText(res)).toBe('{\n  "a": 1\n}');
  });

  it("passes a string value through when text is omitted", () => {
    const res: AgentResponse = { value: "plain" };
    expect(resolveText(res)).toBe("plain");
  });

  it("returns empty string when value is undefined and text is omitted", () => {
    expect(resolveText({} as AgentResponse)).toBe("");
  });
});

describe("navigatePath", () => {
  const root = {
    plan_items: [
      { options: ["a", "b"] },
      { options: ["c"] },
    ],
    user: { name: "Alice", age: 30 },
  };

  it("navigates nested object keys", () => {
    expect(navigatePath(root, "user.name")).toBe("Alice");
  });

  it("navigates through numeric array indices", () => {
    expect(navigatePath(root, "plan_items.0.options")).toEqual(["a", "b"]);
    expect(navigatePath(root, "plan_items.1.options.0")).toBe("c");
  });

  it("resolves a single top-level key", () => {
    expect(navigatePath(root, "user")).toEqual({ name: "Alice", age: 30 });
  });

  it("returns undefined for a missing key", () => {
    expect(navigatePath(root, "user.email")).toBeUndefined();
  });

  it("returns undefined for an out-of-range / non-integer array index", () => {
    expect(navigatePath(root, "plan_items.5")).toBeUndefined();
    expect(navigatePath(root, "plan_items.foo")).toBeUndefined();
  });

  it("returns undefined when descending into null/undefined mid-path", () => {
    expect(navigatePath({ a: null }, "a.b")).toBeUndefined();
    expect(navigatePath(null, "a")).toBeUndefined();
  });

  it("returns undefined when descending into a primitive mid-path", () => {
    expect(navigatePath({ a: 5 }, "a.b")).toBeUndefined();
  });

  it("preserves falsy leaf values", () => {
    expect(navigatePath({ a: { b: 0 } }, "a.b")).toBe(0);
    expect(navigatePath({ a: { b: false } }, "a.b")).toBe(false);
  });
});
