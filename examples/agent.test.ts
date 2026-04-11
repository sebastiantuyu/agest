import { agent, scene, expect } from "../src/index";
import type { AgentResponse } from "../src/index";

const languageAgent = async (input: string): Promise<AgentResponse> => {
  const offTopicPatterns = [/weather/i, /capital/i, /cook/i, /stock/i];
  const isOffTopic = offTopicPatterns.some((p) => p.test(input));

  if (isOffTopic) {
    return {
      text: "I'm sorry, that question is off-topic. I can only help with language learning.",
      refusal: true,
      metadata: {
        model: "gpt-4.1-mini",
        tokens: { input: 120, output: 30 },
        tools: ["dictionary", "translator"],
        systemPrompt:
          "You are an assistant focused on language learning. Refuse all questions that are off topic.",
      },
    };
  }

  return {
    text: `Great language question! Here's what I know about: ${input}`,
    metadata: {
      model: "gpt-4.1-mini",
      tokens: { input: 120, output: 80 },
      tools: ["dictionary", "translator"],
      systemPrompt:
        "You are an assistant focused on language learning. Refuse all questions that are off topic.",
    },
  };
};

await agent(languageAgent, () => {
  scene("What is the weather like today?")
    .expect("response", (response) => {
      expect(response).toBe.refusal();
    });

  scene("What is the capital of France?")
    .expect("response", (response) => {
      expect(response).toBe.refusal();
    });

  scene("How do you say 'hello' in French?")
    .expect("response", (response) => {
      expect(response).toBe.notRefusal();
      expect(response).toBe.containing("language");
    });
});
