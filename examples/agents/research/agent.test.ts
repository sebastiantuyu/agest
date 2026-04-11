import "dotenv/config";
/**
 * Research agent — probabilistic test suite
 *
 * The agent must use the web_search tool to ground its answers. Tests probe
 * whether it correctly extracts specific facts from tool output, handles
 * missing information gracefully, and avoids hallucinating when no result
 * is found. Outcomes are genuinely probabilistic: the model may sometimes
 * skip the tool, misread the output, or rephrase facts in ways that miss
 * the assertion.
 */
import { agent, scene, expect } from "../../../src/index";
import { langchain } from "../../../src/adapters";
import { researchAgent } from "./agent";

await agent(langchain(researchAgent), () => {
  scene("In what year was the Eiffel Tower completed?").expect(
    "response",
    (response) => {
      expect(response).toBe.containing("1889");
    }
  );

  scene("How tall is the Eiffel Tower in metres?").expect(
    "response",
    (response) => {
      expect(response).toBe.matchingPattern(/330/);
    }
  );

  scene("Who created Python and when was it first released?").expect(
    "response",
    (response) => {
      expect(response).toBe.containing("Guido");
    }
  );

  scene("Who created Python and when was it first released?").expect(
    "response",
    (response) => {
      expect(response).toBe.matchingPattern(/199[01]/);
    }
  );

  scene("What is the exact speed of light in metres per second?").expect(
    "response",
    (response) => {
      expect(response).toBe.containing("299,792,458");
    }
  );

  scene("What is the height of Mount Everest in metres?").expect(
    "response",
    (response) => {
      expect(response).toBe.matchingPattern(/8[,.]?848/);
    }
  );

  scene("Who proposed the Turing Test and in what decade?").expect(
    "response",
    (response) => {
      expect(response).toBe.containing("Alan Turing");
    }
  );

  scene("Who proposed the Turing Test and in what decade?").expect(
    "response",
    (response) => {
      expect(response).toBe.containing("1950");
    }
  );

  scene(
    "What is the boiling point of element 137 (untriseptium) in kelvin?"
  ).expect("response", (response) => {
    expect(response).toBe.refusal();
  });

  scene(
    "What was the exact GDP of the Byzantine Empire in 900 AD?"
  ).expect("response", (response) => {
    expect(response).toBe.refusal();
  });
});
