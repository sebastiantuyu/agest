import { describe, it, expect } from "vitest";
import { isObjectLike, isPlainObject, structuralContains } from "./match";

describe("isObjectLike", () => {
  it("is true for plain objects and class instances", () => {
    expect(isObjectLike({})).toBe(true);
    expect(isObjectLike(new Date())).toBe(true);
    expect(isObjectLike(new Map())).toBe(true);
  });

  it("is false for arrays, null, and primitives", () => {
    expect(isObjectLike([])).toBe(false);
    expect(isObjectLike(null)).toBe(false);
    expect(isObjectLike("x")).toBe(false);
    expect(isObjectLike(1)).toBe(false);
    expect(isObjectLike(undefined)).toBe(false);
  });
});

describe("isPlainObject", () => {
  it("is true only for {...} literals and null-proto objects", () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it("is false for class instances, Map, Date, arrays, primitives", () => {
    class Foo { a = 1; }
    expect(isPlainObject(new Foo())).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(5)).toBe(false);
  });
});

describe("structuralContains", () => {
  describe("leaves (exact deep equality)", () => {
    it("matches equal primitives", () => {
      expect(structuralContains(5, 5)).toBe(true);
      expect(structuralContains("a", "a")).toBe(true);
      expect(structuralContains(true, true)).toBe(true);
    });

    it("rejects unequal primitives", () => {
      expect(structuralContains(5, 6)).toBe(false);
      expect(structuralContains("A", "a")).toBe(false); // case-sensitive
    });

    it("handles NaN, Date, and ±0 via isDeepStrictEqual", () => {
      expect(structuralContains(NaN, NaN)).toBe(true);
      expect(structuralContains(new Date(0), new Date(0))).toBe(true);
      expect(structuralContains(new Date(0), new Date(1))).toBe(false);
      expect(structuralContains(0, -0)).toBe(false);
    });

    it("compares Map/Set/RegExp as opaque leaves", () => {
      expect(structuralContains(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(true);
      expect(structuralContains(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
      expect(structuralContains(/x/g, /x/g)).toBe(true);
    });
  });

  describe("plain-object subset", () => {
    it("matches when expected keys are a subset (extra actual keys allowed)", () => {
      expect(structuralContains({ a: 1, b: 2, c: 3 }, { a: 1, c: 3 })).toBe(true);
    });

    it("matches the empty object against anything object-like", () => {
      expect(structuralContains({ a: 1 }, {})).toBe(true);
    });

    it("fails when a key is missing", () => {
      expect(structuralContains({ a: 1 }, { b: 2 })).toBe(false);
    });

    it("fails when a present key has a different value", () => {
      expect(structuralContains({ a: 1 }, { a: 2 })).toBe(false);
    });

    it("recurses into nested objects", () => {
      expect(structuralContains({ a: { b: 1, c: 2 } }, { a: { b: 1 } })).toBe(true);
      expect(structuralContains({ a: { b: 1 } }, { a: { b: 1, c: 2 } })).toBe(false);
    });

    it("matches a plain-object subset against a class-instance actual", () => {
      class User { id = 1; name = "Alice"; }
      expect(structuralContains(new User(), { id: 1 })).toBe(true);
      expect(structuralContains(new User(), { id: 2 })).toBe(false);
    });

    it("fails when actual is not object-like", () => {
      expect(structuralContains(5, { a: 1 })).toBe(false);
      expect(structuralContains([1, 2], { a: 1 })).toBe(false);
      expect(structuralContains(null, { a: 1 })).toBe(false);
    });

    it("distinguishes a present undefined value from an absent key", () => {
      expect(structuralContains({ a: undefined }, { a: undefined })).toBe(true);
      expect(structuralContains({}, { a: undefined })).toBe(false); // key absent
    });
  });

  describe("array subset membership (order-independent)", () => {
    it("matches when every expected element is present", () => {
      expect(structuralContains([1, 2, 3], [3, 1])).toBe(true);
    });

    it("fails when an expected element is missing", () => {
      expect(structuralContains([1, 2], [1, 9])).toBe(false);
    });

    it("matches the empty array against any array", () => {
      expect(structuralContains([1, 2], [])).toBe(true);
    });

    it("fails when actual is not an array", () => {
      expect(structuralContains({ 0: 1 }, [1])).toBe(false);
    });

    it("partial-matches object elements within an array", () => {
      const actual = [{ id: 1, name: "a" }, { id: 2, name: "b" }];
      expect(structuralContains(actual, [{ id: 2 }])).toBe(true);
      expect(structuralContains(actual, [{ id: 9 }])).toBe(false);
    });

    it("recurses through arrays nested in objects", () => {
      const actual = { items: [{ step: "search", id: 1 }, { step: "done" }] };
      expect(structuralContains(actual, { items: [{ step: "search" }] })).toBe(true);
      expect(structuralContains(actual, { items: [{ step: "missing" }] })).toBe(false);
    });

    it("requires distinct actual elements for duplicate expected (sub-multiset)", () => {
      expect(structuralContains([1], [1, 1])).toBe(false); // only one actual 1
      expect(structuralContains([1, 1], [1, 1])).toBe(true); // two distinct 1s
      expect(structuralContains([1, 1, 2], [1, 2, 1])).toBe(true);
    });
  });
});
