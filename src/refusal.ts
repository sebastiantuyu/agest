import type { AgentResponse } from "./types";

const REFUSAL_PATTERNS = [
  // Explicit inability
  /\bi can'?t\b/i,
  /\bi cannot\b/i,
  /\bi'?m (sorry|unable|not able)\b/i,
  /\bunable to (help|assist|answer|address|respond)\b/i,
  /\bwon'?t be able\b/i,
  // Declination
  /\brefuse\b/i,
  /\bdecline\b/i,
  /\bnot (allowed|permitted|able) to\b/i,
  // Domain restriction (the most common pattern from real LLMs given a scoped system prompt)
  /\bonly (able|here|designed|meant|built|intended) to\b/i,
  /\bcan only (help|assist|answer|address|respond|discuss)\b/i,
  /\bnot (designed|built|meant|here|intended) to\b/i,
  /\bspecializ(e|es|ed|ing)\b/i,
  /\bmy (focus|purpose|role|expertise|area|specialty) (is|are)\b/i,
  /\bfocus(ed)? on (language|languages)\b/i,
  /\boutside (of )?my (scope|capabilities|abilities|expertise|focus|area)\b/i,
  /\bbeyond (my|the) (scope|expertise|capabilities)\b/i,
  /\boff[- ]topic\b/i,
  /\bnot (something|a topic) I can\b/i,
  /\bnot (related|relevant) to\b/i,
  // Polite steering
  /\bstick(ing)? to\b/i,
  /\bhere to (help|assist) with\b/i,
];


/**
 * This is likely to be converted to a LLM as a judge.
 * @returns boolean
 */
export function isRefusal(value: unknown): boolean {
  if (typeof value === "object" && value !== null && "refusal" in value) {
    return (value as AgentResponse).refusal === true;
  }

  const text = typeof value === "string" ? value : String(value);
  return REFUSAL_PATTERNS.some((p) => p.test(text));
}
