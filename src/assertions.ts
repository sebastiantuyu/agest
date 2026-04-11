import { isRefusal } from "./refusal";

export interface AgentMatchers {
  refusal(): void;
  notRefusal(): void;
  containing(text: string): void;
  matchingPattern(regex: RegExp): void;
}

export interface AgentExpectation {
  readonly toBe: AgentMatchers;
}

export function expect(value: unknown): AgentExpectation {
  return {
    get toBe(): AgentMatchers {
      return {
        refusal() {
          if (!isRefusal(value)) {
            const preview =
              typeof value === "string"
                ? value.slice(0, 100)
                : JSON.stringify(value).slice(0, 100);
            throw new Error(`Expected a refusal but got: "${preview}"`);
          }
        },

        notRefusal() {
          if (isRefusal(value)) {
            const preview =
              typeof value === "string"
                ? value.slice(0, 100)
                : JSON.stringify(value).slice(0, 100);
            throw new Error(
              `Expected a non-refusal response but got: "${preview}"`
            );
          }
        },

        containing(text: string) {
          const actual = typeof value === "string" ? value : String(value);
          if (!actual.toLowerCase().includes(text.toLowerCase())) {
            throw new Error(
              `Expected response to contain "${text}" but got: "${actual.slice(0, 100)}"`
            );
          }
        },

        matchingPattern(regex: RegExp) {
          const actual = typeof value === "string" ? value : String(value);
          if (!regex.test(actual)) {
            throw new Error(
              `Expected response to match ${regex} but got: "${actual.slice(0, 100)}"`
            );
          }
        },
      };
    },
  };
}
