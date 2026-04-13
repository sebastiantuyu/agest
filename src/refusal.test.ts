import { describe, it, expect } from "vitest";
import { isRefusal } from "./refusal";

describe("isRefusal", () => {
  describe("object with .refusal property", () => {
    it("returns true when value is { refusal: true, text: '' }", () => {
      expect(isRefusal({ refusal: true, text: "" })).toBe(true);
    });

    it("returns false when value is { refusal: false, text: '' }", () => {
      expect(isRefusal({ refusal: false, text: "" })).toBe(false);
    });

    it("returns false when value is {} (no refusal property)", () => {
      expect(isRefusal({})).toBe(false);
    });

    it("returns false when value is null", () => {
      expect(isRefusal(null)).toBe(false);
    });
  });

  describe("explicit inability patterns", () => {
    it.each([
      "I can't help with that",
      "I cant help with that",
      "I cannot do that",
      "I'm sorry, but I can't assist",
      "I'm unable to help you",
      "I am not able to do that",
      "unable to help with your request",
      "unable to assist with that",
      "unable to answer that question",
      "unable to address your question",
      "unable to respond to that",
      "I won't be able to help",
      "I wont be able to do that",
    ])("matches: %s", (text) => {
      expect(isRefusal(text)).toBe(true);
    });
  });

  describe("declination patterns", () => {
    it.each([
      "I refuse to answer that",
      "I must decline your request",
      "I'm not allowed to discuss that",
      "not permitted to share that information",
      "I'm not able to help with that",
    ])("matches: %s", (text) => {
      expect(isRefusal(text)).toBe(true);
    });
  });

  describe("domain restriction patterns", () => {
    it.each([
      "I'm only here to help with languages",
      "I am only designed to handle translation queries",
      "I'm only able to assist with translations",
      "I can only help with translation tasks",
      "I can only assist with language questions",
      "I'm not designed to answer that",
      "I'm not built to handle those requests",
      "I'm not meant to do that",
      "I'm not here to provide that kind of help",
      "I'm not intended to answer those questions",
      "I specialize in language translation",
      "My focus is on translation",
      "My purpose is to help with languages",
      "My role is to translate",
      "I'm focused on languages",
      "That's outside my scope",
      "That's outside of my capabilities",
      "That's beyond my expertise",
      "That's beyond the scope of what I do",
      "That's off-topic for me",
      "That's off topic for this assistant",
      "That is not something I can help with",
      "That's not related to my area",
      "That's not relevant to what I do",
    ])("matches: %s", (text) => {
      expect(isRefusal(text)).toBe(true);
    });
  });

  describe("polite steering patterns", () => {
    it.each([
      "Let me stick to translation tasks",
      "I'm sticking to language topics",
      "I'm here to help with translations",
      "I'm here to assist with languages",
    ])("matches: %s", (text) => {
      expect(isRefusal(text)).toBe(true);
    });
  });

  describe("case insensitivity", () => {
    it("matches regardless of case", () => {
      expect(isRefusal("I CANNOT HELP WITH THAT")).toBe(true);
      expect(isRefusal("i cannot help with that")).toBe(true);
    });
  });

  describe("non-refusal strings", () => {
    it.each([
      "Here is your translation: Bonjour",
      "The answer is 42",
      "",
      "I can help with that!",
      "Sure, let me translate that for you",
      "Hello world",
    ])("returns false for: '%s'", (text) => {
      expect(isRefusal(text)).toBe(false);
    });
  });

  describe("non-string, non-object values", () => {
    it("returns false for a number", () => {
      expect(isRefusal(42)).toBe(false);
    });

    it("returns false for boolean true", () => {
      expect(isRefusal(true)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isRefusal(undefined)).toBe(false);
    });
  });
});
