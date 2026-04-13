import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRegisterScene = vi.fn();
const mockExecute = vi.fn().mockResolvedValue({ successRate: 1 });

vi.mock("./context", () => {
  const SceneBuilderMock = vi.fn();
  const AgentContextMock = vi.fn().mockImplementation(() => ({
    registerScene: mockRegisterScene,
    execute: mockExecute,
  }));

  let currentCtx: any = null;
  return {
    SceneBuilder: SceneBuilderMock,
    AgentContext: AgentContextMock,
    setContext: vi.fn((ctx: any) => { currentCtx = ctx; }),
    getContext: vi.fn(() => {
      if (!currentCtx) throw new Error("scene() must be called inside an agent() callback");
      return currentCtx;
    }),
  };
});

import { scene, agent } from "./index";
import { setContext, getContext, AgentContext } from "./context";

const mockedSetContext = vi.mocked(setContext);
const mockedGetContext = vi.mocked(getContext);

beforeEach(() => {
  vi.clearAllMocks();
  mockRegisterScene.mockReturnValue({ toBe: {} });
  mockExecute.mockResolvedValue({ successRate: 1 });
});

describe("scene(prompt)", () => {
  it("throws when called outside agent()", () => {
    expect(() => scene("test")).toThrow("scene() must be called inside an agent() callback");
  });
});

describe("agent(executor, fn, options?)", () => {
  it("creates AgentContext with executor and name", async () => {
    const executor = vi.fn();
    await agent(executor, () => {}, { name: "test-agent" });
    expect(AgentContext).toHaveBeenCalledWith(executor, "test-agent");
  });

  it("calls setContext with the new context then clears it", async () => {
    await agent(vi.fn(), () => {});
    expect(mockedSetContext).toHaveBeenCalledTimes(2);
    expect(mockedSetContext.mock.calls[1][0]).toBeNull();
  });

  it("calls fn() synchronously", async () => {
    const fn = vi.fn();
    await agent(vi.fn(), fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("clears context in finally block even if fn throws", async () => {
    await expect(
      agent(vi.fn(), () => { throw new Error("boom"); })
    ).rejects.toThrow("boom");
    expect(mockedSetContext).toHaveBeenLastCalledWith(null);
  });

  it("calls ctx.execute() and returns its result", async () => {
    const report = { successRate: 0.75 };
    mockExecute.mockResolvedValue(report);
    const result = await agent(vi.fn(), () => {});
    expect(result).toBe(report);
  });

  it("works without options parameter", async () => {
    await agent(vi.fn(), () => {});
    expect(AgentContext).toHaveBeenCalledWith(expect.anything(), undefined);
  });
});
