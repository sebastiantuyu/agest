import { agent, scene, expect } from "../../../src/index";
import { langchain } from "../../../src/adapters";
import { reactAgent } from "./agent";

agent(langchain(reactAgent), () => {
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
    }
  );

  scene("What does 'bonjour' mean?").expect("response", (response) => {
    expect(response).toBe.notRefusal();
  });
});
