import { test, expect } from "../src/index";

// Mocking some agent interaction
const getAgentResponse = () => {
  return "I am ready to help.";
};

test("agent setup checks", () => {
  const response = getAgentResponse();
  expect(response).toBe("I am ready to help.");
});
