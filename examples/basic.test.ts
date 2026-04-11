import { test, expect } from "../src/index";

test("basic functionality", () => {
  expect(10).toBe(10);
  expect("hello").toBe("hello");
});

test("failing test (commented out)", () => {
  // Uncomment to see failure
  // expect(true).toBe(false);
});
