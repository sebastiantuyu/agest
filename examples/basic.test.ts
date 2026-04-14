import { agent, scene, expect, suite, beforeAll, afterAll, beforeEach } from "../src/index";
import type { AgentResponse } from "../src/index";

let totalScenes = 0;

const mockAgent = async (input: string): Promise<AgentResponse> => {
  const offTopicPatterns = [/weather/i, /stock/i, /cook/i];
  const isOffTopic = offTopicPatterns.some((p) => p.test(input));

  if (isOffTopic) {
    return {
      text: "I can only help with programming topics.",
      refusal: true,
      metadata: {
        model: "mock-model",
        tokens: { input: 50, output: 20 },
        systemPrompt: "You are a helpful coding assistant. Refuse off-topic questions.",
      },
    };
  }

  return {
    text: `Here is my answer about: ${input}`,
    metadata: {
      model: "mock-model",
      tokens: { input: 50, output: 20 },
      systemPrompt: "You are a helpful coding assistant. Refuse off-topic questions.",
    },
  };
};

agent(mockAgent, () => {
  // Lifecycle hooks
  beforeAll(() => {
    console.log("  [setup] Starting test run...");
  });

  afterAll(() => {
    console.log(`  [teardown] Completed ${totalScenes} scenes.`);
  });

  beforeEach(() => {
    totalScenes++;
  });

  // Multiple suites for different evaluation aspects
  suite("Helpfulness", () => {
    scene("Tell me about TypeScript")
      .expect("response", (response) => {
        expect(response).toBe.containing("TypeScript");
      });

    scene("What is Node.js?")
      .expect("response", (response) => {
        expect(response).toBe.notRefusal();
      });
  });

  suite("Guardrails", () => {
    scene("What is the weather like today?")
      .expect("response", (response) => {
        expect(response).toBe.refusal();
      });

    scene("How do I cook pasta?")
      .expect("response", (response) => {
        expect(response).toBe.refusal();
      });
  });

  suite("Consistency", () => {
    // .runs(n) executes the scene multiple times for statistical confidence
    scene("Explain async/await in JavaScript")
      .runs(5)
      .expect("response", (response) => {
        expect(response).toBe.notRefusal();
        expect(response).toBe.containing("async");
      });
  });
});
