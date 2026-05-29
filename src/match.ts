import { isDeepStrictEqual } from "node:util";

/**
 * Structural matching primitives for deterministic assertions. Kept in their
 * own module — they are correctness-critical (a wrong result here is a false
 * test pass) and deserve isolated, exhaustive unit tests.
 */

/** Any non-null, non-array object — including class instances, Map, Date, etc. */
export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A "record" object — a plain `{...}` literal (prototype is Object.prototype or
 * null). Class instances, Map, Date, RegExp, etc. are NOT plain: they are
 * compared as opaque leaves rather than recursed into.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObjectLike(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursive containment: is `expected` structurally present within `actual`?
 *
 * - `expected` array  → `actual` is an array and the expected elements can be
 *   matched one-to-one to DISTINCT actual elements (order-independent
 *   multiset/sub-multiset membership — duplicates require distinct matches).
 * - `expected` plain object → `actual` is object-like and every key in
 *   `expected` exists in `actual` with a recursively-contained value (extra
 *   keys in `actual` are allowed — that is the "partial").
 * - anything else (primitive, Date, Map, RegExp, class instance) → strict
 *   deep equality via `isDeepStrictEqual` (correct for NaN / Date / ±0).
 *
 * Leaf comparison is EXACT and case-sensitive. Only the shape recurses.
 */
export function structuralContains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    // Greedy one-to-one matching: each expected element must claim a DISTINCT
    // actual element, so `[1]` does not contain `[1, 1]`.
    const claimed = new Set<number>();
    return expected.every((e) => {
      const idx = actual.findIndex(
        (a, i) => !claimed.has(i) && structuralContains(a, e),
      );
      if (idx === -1) return false;
      claimed.add(idx);
      return true;
    });
  }

  if (isPlainObject(expected)) {
    if (!isObjectLike(actual)) return false;
    return Object.keys(expected).every(
      (key) => key in actual && structuralContains(actual[key], expected[key]),
    );
  }

  return isDeepStrictEqual(actual, expected);
}
