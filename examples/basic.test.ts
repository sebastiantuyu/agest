import { agent, scene, expect } from "../src/index";
import type { AgentResponse } from "../src/index";

const mockAgent = async (input: string): Promise<AgentResponse> => {
  return {
    text: `Here is my answer about: ${input}`,
    metadata: {
      model: "mock-model",
      tokens: { input: 50, output: 20 },
      systemPrompt: "You are a helpful assistant.",
    },
  };
};

await agent(mockAgent, () => {
  scene("Tell me about TypeScript")
    .expect("response", (response) => {
      expect(response).toBe.containing("TypeScript");
    });

  scene("What is Node.js?")
    .expect("response", (response) => {
      expect(response).toBe.notRefusal();
    });
});
