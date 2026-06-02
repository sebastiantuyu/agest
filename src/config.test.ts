import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { defineConfig, loadConfig } from "./config.js";

describe("defineConfig", () => {
  it("returns the exact config object passed in", () => {
    const config = { parallelism: 4, timeout: 5000 };
    expect(defineConfig(config)).toBe(config);
  });

  it("works with empty object", () => {
    expect(defineConfig({})).toEqual({});
  });

  it("works with all fields populated", () => {
    const config = {
      parallelism: 2,
      timeout: 10000,
      turns: 3,
      judge: { model: "gpt-4", apiKey: "key", baseUrl: "http://localhost" },
    };
    expect(defineConfig(config)).toBe(config);
  });

  it("preserves the areas block (extends / include / exclude)", () => {
    const config = defineConfig({
      areas: {
        extends: ["agest/recommended"],
        include: ["billing", { id: "refusal", minScenes: 10 }],
        exclude: ["memory"],
      },
    });
    expect(config.areas).toEqual({
      extends: ["agest/recommended"],
      include: ["billing", { id: "refusal", minScenes: 10 }],
      exclude: ["memory"],
    });
  });
});

describe("loadConfig", () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/fake/project");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns {} when neither .ts nor .js config exists", async () => {
    const result = await loadConfig();
    expect(result).toEqual({});
  });
});
