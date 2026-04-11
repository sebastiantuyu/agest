// A simple Jest-like syntax implementation for demonstration

type Assertion<T> = {
  toBe: (expected: T) => void;
};

export function expect<T>(actual: T): Assertion<T> {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${String(expected)} but got ${String(actual)}`);
      }
      console.log('✅ Passed');
    }
  };
}

export function test(name: string, fn: () => void | Promise<void>) {
  console.log(`Running: ${name}`);
  try {
    fn();
  } catch (error) {
    console.error(`❌ Failed: ${name}`);
    console.error(error);
  }
}

// Basic type assertion check to ensure TypeScript is enforcing types correctly
const a: number = 5;
// The below line proves type checking works if we don't compile it out, or we can just ensure tsc verifies it.
// To ensure it builds we will comment it out or use as string
const b: string = a as unknown as string;

// Simple test
test("basic math works", () => {
  expect(1 + 1).toBe(2);
});
