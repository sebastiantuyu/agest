import { describe, it, expect as vitestExpect, vi, beforeEach } from "vitest";

vi.mock("./refusal", () => ({
  isRefusal: vi.fn(),
}));

import { expect as agestExpect, collectPendingJudgements } from "./assertions";
import { isRefusal } from "./refusal";

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

  describe(".containing(text)", () => {
    it("does not throw when string contains text", () => {
      vitestExpect(() => agestExpect("Hello World").toBe.containing("hello")).not.toThrow();
    });

    it("is case-insensitive", () => {
      vitestExpect(() => agestExpect("HELLO").toBe.containing("hello")).not.toThrow();
    });

    it("throws when string does not contain text", () => {
      vitestExpect(() => agestExpect("Hello").toBe.containing("xyz")).toThrow(
        'Expected response to contain "xyz" but got: "Hello"'
      );
    });

    it("coerces non-string values via String()", () => {
      vitestExpect(() => agestExpect(12345).toBe.containing("234")).not.toThrow();
    });

    it("truncates preview to 100 chars in error", () => {
      const longStr = "a".repeat(200);
      try {
        agestExpect(longStr).toBe.containing("zzz");
        vitestExpect.unreachable();
      } catch (err) {
        const msg = (err as Error).message;
        const match = msg.match(/got: "(.+)"/);
        vitestExpect(match![1].length).toBeLessThanOrEqual(100);
      }
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
