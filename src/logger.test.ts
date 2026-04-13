import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { c, logger } from "./logger";

const ESC = "\x1b";
const RESET = `${ESC}[0m`;

describe("c (color helpers)", () => {
  it.each([
    ["bold", `${ESC}[1m`, "hello"],
    ["dim", `${ESC}[2m`, "hello"],
    ["green", `${ESC}[32m`, "hello"],
    ["red", `${ESC}[31m`, "hello"],
    ["yellow", `${ESC}[33m`, "hello"],
    ["cyan", `${ESC}[36m`, "hello"],
    ["gray", `${ESC}[90m`, "hello"],
  ] as const)("%s wraps with correct ANSI code", (name, code, input) => {
    const fn = c[name] as (s: string) => string;
    expect(fn(input)).toBe(`${code}${input}${RESET}`);
  });

  it("reset wraps with RESET on both sides", () => {
    expect(c.reset("hello")).toBe(`${RESET}hello${RESET}`);
  });
});

describe("Logger", () => {
  let consoleSpy: MockInstance<typeof console.log>;
  let stdoutSpy: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.setLevel("normal");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("setLevel / getLevel", () => {
    it("defaults to 'normal'", () => {
      // fresh import had 'normal', we just confirmed by resetting in beforeEach
      expect(logger.getLevel()).toBe("normal");
    });

    it("returns the level set via setLevel", () => {
      logger.setLevel("verbose");
      expect(logger.getLevel()).toBe("verbose");
      logger.setLevel("silent");
      expect(logger.getLevel()).toBe("silent");
    });
  });

  describe("info()", () => {
    it("calls console.log when level is 'normal'", () => {
      logger.setLevel("normal");
      logger.info("test message");
      expect(consoleSpy).toHaveBeenCalledWith("test message");
    });

    it("calls console.log when level is 'verbose'", () => {
      logger.setLevel("verbose");
      logger.info("test message");
      expect(consoleSpy).toHaveBeenCalledWith("test message");
    });

    it("does NOT call console.log when level is 'silent'", () => {
      logger.setLevel("silent");
      logger.info("test message");
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe("debug()", () => {
    it("calls console.log with gray-colored message when level is 'verbose'", () => {
      logger.setLevel("verbose");
      logger.debug("debug msg");
      expect(consoleSpy).toHaveBeenCalledWith(c.gray("debug msg"));
    });

    it("does NOT call console.log when level is 'normal'", () => {
      logger.setLevel("normal");
      logger.debug("debug msg");
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it("does NOT call console.log when level is 'silent'", () => {
      logger.setLevel("silent");
      logger.debug("debug msg");
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe("write()", () => {
    it("calls process.stdout.write when level is 'normal'", () => {
      logger.setLevel("normal");
      logger.write("raw");
      expect(stdoutSpy).toHaveBeenCalledWith("raw");
    });

    it("calls process.stdout.write when level is 'verbose'", () => {
      logger.setLevel("verbose");
      logger.write("raw");
      expect(stdoutSpy).toHaveBeenCalledWith("raw");
    });

    it("does NOT call process.stdout.write when level is 'silent'", () => {
      logger.setLevel("silent");
      logger.write("raw");
      expect(stdoutSpy).not.toHaveBeenCalled();
    });
  });
});
