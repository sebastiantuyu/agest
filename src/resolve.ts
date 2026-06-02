import type { AgentResponse } from "./types.js";

/**
 * Serialize an arbitrary agent value to the string view the judge model and
 * the text matchers consume. Strings pass through untouched; everything else
 * is JSON. This is the ONLY place a structured value is forced to a string,
 * and it happens lazily — never before a matcher actually needs text.
 */
export function serializeValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * The agent's native output — the source of truth for deterministic,
 * structural assertions. Tolerates a legacy `{ text }`-only response (no
 * `value`) so executors can migrate incrementally.
 */
export function resolveValue<T>(response: AgentResponse<T>): T | string | undefined {
  if (response.value !== undefined) return response.value;
  return response.text;
}

/**
 * The string view for the judge and text matchers. An explicit `text` wins
 * (it's the enriched projection the executor chose to expose); otherwise we
 * serialize `value` on demand.
 */
export function resolveText<T>(response: AgentResponse<T>): string {
  if (typeof response.text === "string") return response.text;
  return serializeValue(response.value);
}

/**
 * Walk a dot-path (with numeric array indices) into an arbitrary object.
 * Returns `undefined` if any segment is missing. e.g. "plan_items.0.options".
 */
export function navigatePath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}
