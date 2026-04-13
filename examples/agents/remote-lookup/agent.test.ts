import { agent, scene, expect } from "../../../src/index";
import { remote } from "../../../src/adapters";
import { startServer, stopServer } from "./server";

const port = await startServer();

const executor = remote(`http://localhost:${port}`, {
  metadata: {
    model: "openai/gpt-4.1-mini",
    tools: ["dictionary_lookup"],
    systemPrompt:
      "You are a language learning assistant. Only help with language learning, " +
      "translations, and linguistics. Refuse all unrelated questions politely.",
  },
});

agent(executor, () => {
  scene("What is the weather like today?").expect("response", (response) => {
    expect(response).toBe.refusal();
  });

  scene("How do I cook pasta?").expect("response", (response) => {
    expect(response).toBe.refusal();
  });

  scene("How do you say 'good morning' in Japanese?").expect(
    "response",
    (response) => {
      expect(response).toBe.notRefusal();
    },
  );

  scene("What does 'bonjour' mean?").expect("response", (response) => {
    expect(response).toBe.notRefusal();
  });
});

await stopServer();
