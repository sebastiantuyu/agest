import { isDeepStrictEqual } from "node:util";
import { isRefusal } from "./refusal";
import { serializeValue } from "./resolve";
import { isObjectLike, isPlainObject, structuralContains } from "./match";
import { validateSync, type StandardSchemaV1 } from "./schema";
import type { JudgeCriteria } from "./judge";

export interface PendingJudgement {
  value: unknown;
  criteria: JudgeCriteria;
}

let pendingJudgements: PendingJudgement[] = [];

export function collectPendingJudgements(): PendingJudgement[] {
  const collected = pendingJudgements;
  pendingJudgements = [];
  return collected;
}

export interface AgentMatchers {
  /** Assert the agent refused. */
  refusal(): void;
  /** Assert the agent did NOT refuse. */
  notRefusal(): void;
  /**
   * Text containment: `text` appears as a substring. For a non-string value the
   * serialized form is searched. Case-INsensitive by default; pass
   * `{ caseSensitive: true }` for an exact substring.
   */
  containingText(text: string | number, opts?: { caseSensitive?: boolean }): void;
  /** Assert text containment does NOT hold. See {@link containingText}. */
  notContainingText(text: string | number, opts?: { caseSensitive?: boolean }): void;
  /**
   * Array membership: the value is an array containing `item` as an EXACT
   * (deep-equal) element. Throws if the value is not an array. Use
   * {@link containingSubset} when you want partial element matching.
   */
  containingItem(item: unknown): void;
  /**
   * Structural subset: `subset` is recursively contained in the value.
   * - object value + object `subset` → every key in `subset` is present with a
   *   recursively-contained value (extra keys allowed).
   * - array value + array `subset` → every `subset` element matches a distinct
   *   element of the value (partial element matching, order-independent).
   *
   * Exact at the leaves (case-sensitive). Throws if the value is not an
   * object/array, or `subset` is not an object/array.
   */
  containingSubset(subset: object): void;
  /** Assert the serialized text view matches `pattern`. */
  matchingPattern(pattern: RegExp): void;
  /** Deep structural equality against the native value. */
  equalTo(expected: unknown): void;
  /** Assert deep structural INequality against the native value. */
  notEqualTo(expected: unknown): void;
  /** Assert the value (array/string) has length `n`. */
  ofLength(n: number): void;
  /**
   * Validate the native value against a Standard Schema (zod 4, valibot,
   * arktype, …). Throws with the schema's formatted issues on failure.
   * Synchronous — for async (`refine`-style) schemas, declare the schema at the
   * agent() or scene().expectSchema() level instead.
   */
  matchingSchema(schema: StandardSchemaV1): void;
  /**
   * Escape hatch for anything not covered by a named matcher: a predicate over
   * the native value. Stays deterministic — use it to express negatives too,
   * e.g. `satisfying((v) => !v.includes("secret"))`.
   */
  satisfying(predicate: (value: any) => boolean, message?: string): void;
  /**
   * Queue an LLM-judged assertion, resolved asynchronously by the runner.
   * Fuzzy + paid (express the negative in `failWhen`).
   */
  judgedBy(criteria: JudgeCriteria): void;
}

export interface AgentExpectation {
  readonly toBe: AgentMatchers;
}

/**
 * 100-char preview for error messages. Uses COMPACT JSON for objects (the
 * judge-facing `serializeValue` pretty-prints; error previews stay terse and
 * match the library's original contract).
 */
function preview(value: unknown): string {
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  return s.slice(0, 100);
}

/** Compact one-line form for an inline needle/expected in an error message. */
function compact(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Human-readable type label for diagnostics (e.g. "a number", "an array"). */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/**
 * Substring search shared by `containingText` / `notContainingText`. A string
 * value is searched directly; anything else via its serialized form.
 * Case-insensitive unless `caseSensitive` is set.
 */
function textContains(
  value: unknown,
  text: string | number,
  opts?: { caseSensitive?: boolean },
): { actual: string; hit: boolean } {
  const actual = typeof value === "string" ? value : serializeValue(value);
  const needle = String(text);
  const hit = opts?.caseSensitive
    ? actual.includes(needle)
    : actual.toLowerCase().includes(needle.toLowerCase());
  return { actual, hit };
}

function makeMatchers(value: unknown): AgentMatchers {
  const assert = (cond: boolean, message: string): void => {
    if (!cond) throw new Error(message);
  };

  return {
    refusal() {
      assert(isRefusal(value), `Expected a refusal but got: "${preview(value)}"`);
    },

    notRefusal() {
      assert(
        !isRefusal(value),
        `Expected a non-refusal response but got: "${preview(value)}"`,
      );
    },

    containingText(text: string | number, opts?: { caseSensitive?: boolean }) {
      const { actual, hit } = textContains(value, text, opts);
      assert(
        hit,
        `Expected response to contain "${text}" but got: "${actual.slice(0, 100)}"`,
      );
    },

    notContainingText(text: string | number, opts?: { caseSensitive?: boolean }) {
      const { actual, hit } = textContains(value, text, opts);
      assert(
        !hit,
        `Expected response NOT to contain "${text}" but got: "${actual.slice(0, 100)}"`,
      );
    },

    containingItem(item: unknown) {
      if (!Array.isArray(value)) {
        throw new Error(
          `containingItem() expects an array value but got ${describeType(value)}. ` +
            `Use containingText() for substrings or containingSubset() for objects.`,
        );
      }
      assert(
        value.some((el) => isDeepStrictEqual(el, item)),
        `Expected array to contain item ${compact(item)} but it did not (got ${preview(value)})`,
      );
    },

    containingSubset(subset: object) {
      if (!Array.isArray(value) && !isObjectLike(value)) {
        throw new Error(
          `containingSubset() expects an object or array value but got ${describeType(value)}.`,
        );
      }
      if (!Array.isArray(subset) && !isPlainObject(subset)) {
        throw new Error(
          `containingSubset() expects an object or array subset but got ${describeType(subset)}.`,
        );
      }
      assert(
        structuralContains(value, subset),
        `Expected value to contain subset ${compact(subset)} but it did not (got ${preview(value)})`,
      );
    },

    matchingPattern(pattern: RegExp) {
      const actual = typeof value === "string" ? value : serializeValue(value);
      assert(
        pattern.test(actual),
        `Expected response to match ${pattern} but got: "${actual.slice(0, 100)}"`,
      );
    },

    equalTo(expected: unknown) {
      assert(
        isDeepStrictEqual(value, expected),
        `Expected value to equal ${compact(expected)} but got ${preview(value)}`,
      );
    },

    notEqualTo(expected: unknown) {
      assert(
        !isDeepStrictEqual(value, expected),
        `Expected value NOT to equal ${compact(expected)} but it did`,
      );
    },

    ofLength(n: number) {
      const len =
        typeof value === "string" || Array.isArray(value)
          ? (value as { length: number }).length
          : NaN;
      assert(
        len === n,
        `Expected length ${n} but got ${Number.isNaN(len) ? "a non-measurable value" : len}`,
      );
    },

    matchingSchema(schema: StandardSchemaV1) {
      const outcome = validateSync(schema, value);
      assert(
        outcome.ok,
        `Schema validation failed for value "${preview(value)}" — ${
          outcome.ok ? "" : outcome.message
        }`,
      );
    },

    satisfying(predicate: (value: any) => boolean, message?: string) {
      assert(
        Boolean(predicate(value)),
        message ?? `Predicate failed for value: "${preview(value)}"`,
      );
    },

    judgedBy(criteria: JudgeCriteria) {
      pendingJudgements.push({ value, criteria });
    },
  };
}

export function expect(value: unknown): AgentExpectation {
  return {
    get toBe(): AgentMatchers {
      return makeMatchers(value);
    },
  };
}
