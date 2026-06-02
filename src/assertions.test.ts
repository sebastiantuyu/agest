import { describe, it, expect as vitestExpect, vi, beforeEach } from "vitest";
import { z } from "zod";

vi.mock("./refusal", () => ({
  isRefusal: vi.fn(),
}));

import { expect as agestExpect, collectPendingJudgements } from "./assertions.js";
import { isRefusal } from "./refusal.js";

const mockedIsRefusal = vi.mocked(isRefusal);

beforeEach(() => {
  vi.clearAllMocks();
  collectPendingJudgements(); // drain any leftover state
});

describe("expect(value).toBe", () => {
  describe(".refusal()", () => {
    it("does not throw when isRefusal returns true", () => {
      mockedIsRefusal.mockReturnValue(true);
      vitestExpect(() => agestExpect("I cannot help").toBe.refusal()).not.toThrow();
    });

    it("throws when isRefusal returns false (string preview)", () => {
      mockedIsRefusal.mockReturnValue(false);
      vitestExpect(() => agestExpect("Hello world").toBe.refusal()).toThrow(
        'Expected a refusal but got: "Hello world"'
      );
    });

    it("throws with JSON preview for object values", () => {
      mockedIsRefusal.mockReturnValue(false);
      vitestExpect(() => agestExpect({ text: "hi" }).toBe.refusal()).toThrow(
        'Expected a refusal but got: "{"text":"hi"}'
      );
    });

    it("truncates preview to 100 characters for long strings", () => {
      mockedIsRefusal.mockReturnValue(false);
      const longStr = "x".repeat(200);
      try {
        agestExpect(longStr).toBe.refusal();
        vitestExpect.unreachable();
      } catch (err) {
        const msg = (err as Error).message;
        // The preview inside quotes should be at most 100 chars
        const match = msg.match(/"(.+)"/);
        vitestExpect(match).toBeTruthy();
        vitestExpect(match![1].length).toBeLessThanOrEqual(100);
      }
    });
  });

  describe(".notRefusal()", () => {
    it("does not throw when isRefusal returns false", () => {
      mockedIsRefusal.mockReturnValue(false);
      vitestExpect(() => agestExpect("Hello").toBe.notRefusal()).not.toThrow();
    });

    it("throws when isRefusal returns true (string preview)", () => {
      mockedIsRefusal.mockReturnValue(true);
      vitestExpect(() => agestExpect("I cannot help").toBe.notRefusal()).toThrow(
        'Expected a non-refusal response but got: "I cannot help"'
      );
    });

    it("throws with JSON preview for object values", () => {
      mockedIsRefusal.mockReturnValue(true);
      vitestExpect(() => agestExpect({ a: 1 }).toBe.notRefusal()).toThrow(
        'Expected a non-refusal response but got: "{"a":1}'
      );
    });
  });

  describe(".containingText(text)", () => {
    it("does not throw when string contains text", () => {
      vitestExpect(() => agestExpect("Hello World").toBe.containingText("hello")).not.toThrow();
    });

    it("is case-insensitive by default", () => {
      vitestExpect(() => agestExpect("HELLO").toBe.containingText("hello")).not.toThrow();
    });

    it("respects caseSensitive: true", () => {
      vitestExpect(() =>
        agestExpect("HELLO").toBe.containingText("hello", { caseSensitive: true })
      ).toThrow();
      vitestExpect(() =>
        agestExpect("HELLO").toBe.containingText("HELLO", { caseSensitive: true })
      ).not.toThrow();
    });

    it("throws when string does not contain text", () => {
      vitestExpect(() => agestExpect("Hello").toBe.containingText("xyz")).toThrow(
        'Expected response to contain "xyz" but got: "Hello"'
      );
    });

    it("searches the serialized form of a non-string value", () => {
      vitestExpect(() => agestExpect(12345).toBe.containingText("234")).not.toThrow();
      vitestExpect(() => agestExpect({ city: "Paris" }).toBe.containingText("paris")).not.toThrow();
    });

    it("truncates preview to 100 chars in error", () => {
      const longStr = "a".repeat(200);
      try {
        agestExpect(longStr).toBe.containingText("zzz");
        vitestExpect.unreachable();
      } catch (err) {
        const msg = (err as Error).message;
        const match = msg.match(/got: "(.+)"/);
        vitestExpect(match![1].length).toBeLessThanOrEqual(100);
      }
    });
  });

  describe(".notContainingText(text)", () => {
    it("passes when the text is absent", () => {
      vitestExpect(() => agestExpect("Hello").toBe.notContainingText("secret")).not.toThrow();
    });

    it("throws when the text is present", () => {
      vitestExpect(() => agestExpect("my password is hunter2").toBe.notContainingText("password")).toThrow(
        "Expected response NOT to contain"
      );
    });

    it("checks the serialized form of a structured value (leak guard)", () => {
      vitestExpect(() =>
        agestExpect({ user: "a", ssn: "123-45-6789" }).toBe.notContainingText("123-45-6789")
      ).toThrow("Expected response NOT to contain");
    });
  });

  describe(".matchingPattern(regex)", () => {
    it("does not throw when string matches regex", () => {
      vitestExpect(() => agestExpect("abc123").toBe.matchingPattern(/\d+/)).not.toThrow();
    });

    it("throws when string does not match regex", () => {
      vitestExpect(() => agestExpect("abc").toBe.matchingPattern(/\d+/)).toThrow(
        "Expected response to match /\\d+/ but got:"
      );
    });

    it("coerces non-string values via String()", () => {
      vitestExpect(() => agestExpect(42).toBe.matchingPattern(/42/)).not.toThrow();
    });
  });

  describe(".judgedBy(criteria)", () => {
    it("pushes to pending judgements without throwing", () => {
      const criteria = { criteria: "test", failWhen: "always" };
      vitestExpect(() => agestExpect("response").toBe.judgedBy(criteria)).not.toThrow();
      const pending = collectPendingJudgements();
      vitestExpect(pending).toHaveLength(1);
      vitestExpect(pending[0]).toEqual({ value: "response", criteria });
    });
  });
});

describe("expect(value).toBe — structural matchers", () => {
  describe(".containingItem(item) — exact array membership", () => {
    it("matches a primitive element", () => {
      vitestExpect(() => agestExpect([1, 2, 3]).toBe.containingItem(2)).not.toThrow();
    });

    it("matches an exact object element", () => {
      vitestExpect(() =>
        agestExpect([{ id: 1 }, { id: 2 }]).toBe.containingItem({ id: 2 })
      ).not.toThrow();
    });

    it("is EXACT — a partial object is not a member", () => {
      vitestExpect(() =>
        agestExpect([{ id: 1, name: "a" }]).toBe.containingItem({ id: 1 })
      ).toThrow("Expected array to contain item");
    });

    it("does not coerce primitives", () => {
      vitestExpect(() => agestExpect([1, 2, 3]).toBe.containingItem("2")).toThrow();
    });

    it("throws when the value is not an array", () => {
      vitestExpect(() => agestExpect({ a: 1 }).toBe.containingItem(1)).toThrow(
        "containingItem() expects an array value"
      );
    });
  });

  describe(".containingSubset(subset) — recursive subset", () => {
    it("matches a shallow object subset (extra keys allowed)", () => {
      vitestExpect(() =>
        agestExpect({ city: "Paris", country: "FR" }).toBe.containingSubset({ city: "Paris" })
      ).not.toThrow();
    });

    it("matches a nested object subset", () => {
      vitestExpect(() =>
        agestExpect({ user: { id: 1, name: "Alice" } }).toBe.containingSubset({ user: { id: 1 } })
      ).not.toThrow();
    });

    it("partial-matches an object element inside an array value", () => {
      vitestExpect(() =>
        agestExpect([{ id: 1, name: "a" }, { id: 2, name: "b" }]).toBe.containingSubset([{ id: 2 }])
      ).not.toThrow();
    });

    it("partial-matches an object inside a nested array", () => {
      vitestExpect(() =>
        agestExpect({ plan_items: [{ step: "search", id: 1 }, { step: "done" }] })
          .toBe.containingSubset({ plan_items: [{ step: "search" }] })
      ).not.toThrow();
    });

    it("throws when the subset does not match", () => {
      vitestExpect(() =>
        agestExpect({ city: "Paris" }).toBe.containingSubset({ city: "London" })
      ).toThrow("Expected value to contain subset");
    });

    it("is exact (case-sensitive) at the leaves", () => {
      vitestExpect(() =>
        agestExpect({ city: "Paris" }).toBe.containingSubset({ city: "paris" })
      ).toThrow();
    });

    it("throws when the value is not an object/array", () => {
      vitestExpect(() => agestExpect("Paris").toBe.containingSubset({ city: "Paris" })).toThrow(
        "containingSubset() expects an object or array value"
      );
    });

    it("throws when the subset is not an object/array", () => {
      vitestExpect(() =>
        // @ts-expect-error — subset must be object/array
        agestExpect({ a: 1 }).toBe.containingSubset(1)
      ).toThrow("containingSubset() expects an object or array subset");
    });
  });

  describe(".equalTo(expected)", () => {
    it("passes on deep structural equality", () => {
      vitestExpect(() =>
        agestExpect({ a: [1, 2], b: "x" }).toBe.equalTo({ a: [1, 2], b: "x" })
      ).not.toThrow();
    });

    it("throws on structural mismatch", () => {
      vitestExpect(() =>
        agestExpect({ a: 1 }).toBe.equalTo({ a: 2 })
      ).toThrow("Expected value to equal");
    });

    it("distinguishes arrays of differing length", () => {
      vitestExpect(() => agestExpect([1, 2]).toBe.equalTo([1, 2, 3])).toThrow();
    });

    // Cases the previous hand-rolled deepEqual mishandled — now covered by
    // node:util's isDeepStrictEqual.
    it("treats NaN as equal to NaN", () => {
      vitestExpect(() => agestExpect(NaN).toBe.equalTo(NaN)).not.toThrow();
      vitestExpect(() => agestExpect([NaN]).toBe.equalTo([NaN])).not.toThrow();
    });

    it("compares Date instances by value", () => {
      vitestExpect(() =>
        agestExpect(new Date(0)).toBe.equalTo(new Date(0))
      ).not.toThrow();
      vitestExpect(() =>
        agestExpect(new Date(0)).toBe.equalTo(new Date(1))
      ).toThrow();
    });

    it("distinguishes +0 and -0 (strict equality)", () => {
      vitestExpect(() => agestExpect(0).toBe.equalTo(-0)).toThrow();
    });

    it("deeply compares nested objects/arrays", () => {
      vitestExpect(() =>
        agestExpect({ a: { b: [1, { c: 2 }] } }).toBe.equalTo({ a: { b: [1, { c: 2 }] } })
      ).not.toThrow();
      vitestExpect(() =>
        agestExpect({ a: { b: [1, { c: 2 }] } }).toBe.equalTo({ a: { b: [1, { c: 3 }] } })
      ).toThrow();
    });
  });

  describe(".notEqualTo(expected)", () => {
    it("passes when values differ", () => {
      vitestExpect(() => agestExpect({ a: 1 }).toBe.notEqualTo({ a: 2 })).not.toThrow();
    });

    it("throws on deep structural equality", () => {
      vitestExpect(() =>
        agestExpect({ a: [1, 2] }).toBe.notEqualTo({ a: [1, 2] })
      ).toThrow("Expected value NOT to equal");
    });
  });

  describe(".ofLength(n)", () => {
    it("passes for an array of the given length", () => {
      vitestExpect(() => agestExpect([1, 2, 3]).toBe.ofLength(3)).not.toThrow();
    });

    it("passes for a string of the given length", () => {
      vitestExpect(() => agestExpect("abc").toBe.ofLength(3)).not.toThrow();
    });

    it("throws on length mismatch", () => {
      vitestExpect(() => agestExpect([1, 2]).toBe.ofLength(3)).toThrow(
        "Expected length 3 but got 2"
      );
    });

    it("reports a non-measurable value for objects", () => {
      vitestExpect(() => agestExpect({ a: 1 }).toBe.ofLength(1)).toThrow(
        "non-measurable value"
      );
    });
  });

  describe(".satisfying(predicate)", () => {
    it("passes when the predicate returns truthy", () => {
      vitestExpect(() =>
        agestExpect({ score: 0.9 }).toBe.satisfying((v) => v.score > 0.5)
      ).not.toThrow();
    });

    it("throws with the default message when the predicate fails", () => {
      vitestExpect(() =>
        agestExpect("nope").toBe.satisfying(() => false)
      ).toThrow("Predicate failed for value:");
    });

    it("throws with a custom message when provided", () => {
      vitestExpect(() =>
        agestExpect(3).toBe.satisfying((v) => v > 10, "must exceed 10")
      ).toThrow("must exceed 10");
    });
  });

  describe(".matchingSchema(schema)", () => {
    const Plan = z.object({
      plan_items: z.array(z.object({ step: z.string() })),
    });

    it("passes when the value conforms to the schema", () => {
      vitestExpect(() =>
        agestExpect({ plan_items: [{ step: "search" }] }).toBe.matchingSchema(Plan)
      ).not.toThrow();
    });

    it("throws with the schema's formatted issues on a mismatch", () => {
      vitestExpect(() =>
        agestExpect({ plan_items: [{ step: 42 }] }).toBe.matchingSchema(Plan)
      ).toThrow(/Schema validation failed.*plan_items\.0\.step/s);
    });

    it("validates a field value, not just the whole object", () => {
      vitestExpect(() =>
        agestExpect("book_flight").toBe.matchingSchema(z.string())
      ).not.toThrow();
      vitestExpect(() =>
        agestExpect(42).toBe.matchingSchema(z.string())
      ).toThrow(/Schema validation failed/);
    });

    it("throws a directive error for an async schema", () => {
      vitestExpect(() =>
        agestExpect("x").toBe.matchingSchema(z.string().refine(async () => true))
      ).toThrow(/async schema/i);
    });
  });
});

describe("collectPendingJudgements()", () => {
  it("returns empty array when nothing has been pushed", () => {
    vitestExpect(collectPendingJudgements()).toEqual([]);
  });

  it("returns all pending judgements and drains the array", () => {
    const c1 = { criteria: "a", failWhen: "x" };
    const c2 = { criteria: "b", failWhen: "y" };
    agestExpect("val1").toBe.judgedBy(c1);
    agestExpect("val2").toBe.judgedBy(c2);

    const result = collectPendingJudgements();
    vitestExpect(result).toHaveLength(2);
    vitestExpect(result[0].value).toBe("val1");
    vitestExpect(result[1].value).toBe("val2");
  });

  it("returns empty array on second call (drained)", () => {
    agestExpect("val").toBe.judgedBy({ criteria: "c", failWhen: "f" });
    collectPendingJudgements();
    vitestExpect(collectPendingJudgements()).toEqual([]);
  });
});
