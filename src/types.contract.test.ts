import { describe, it, expectTypeOf } from "vitest";
import { agent } from "./index";
import { executeScene, extractField } from "./runner";
import type {
  AgentExecutor,
  AgentResponse,
  RunResult,
  SceneResult,
  AgentReport,
} from "./types";

/**
 * Type-level guards. These assert the generic `T` is THREADED through every
 * stage of the pipeline — not merely declared on `AgentResponse` and then
 * erased. If any stage drops `T` (the "looks typed but isn't" regression),
 * these stop compiling and the suite fails to typecheck.
 *
 * Everything here is purely type-level (instantiation expressions, no calls),
 * so nothing executes or writes a report.
 */
interface Plan {
  plan_items: { step: string }[];
}

describe("generic T flows through the pipeline (type-level)", () => {
  it("threads T from executor → executeScene → SceneResult.response.value", () => {
    expectTypeOf(executeScene<Plan>).returns.resolves.toEqualTypeOf<SceneResult<Plan>>();
    expectTypeOf<SceneResult<Plan>["response"]>().toEqualTypeOf<AgentResponse<Plan>>();
    expectTypeOf<SceneResult<Plan>["response"]["value"]>().toEqualTypeOf<Plan | undefined>();
    expectTypeOf<Parameters<typeof executeScene<Plan>>[0]>().toEqualTypeOf<AgentExecutor<Plan>>();
  });

  it("threads T into RunResult for multi-run aggregation", () => {
    expectTypeOf<RunResult<Plan>["response"]>().toEqualTypeOf<AgentResponse<Plan>>();
    expectTypeOf<NonNullable<SceneResult<Plan>["runs"]>[number]>().toEqualTypeOf<
      RunResult<Plan>
    >();
  });

  it("threads T from agent() to its returned AgentReport", () => {
    expectTypeOf(agent<Plan>).returns.resolves.toEqualTypeOf<AgentReport<Plan>>();
    expectTypeOf<AgentReport<Plan>["results"]>().toEqualTypeOf<SceneResult<Plan>[]>();
  });

  it("keeps extractField return as unknown (dynamic field access)", () => {
    expectTypeOf(extractField<Plan>).returns.toEqualTypeOf<unknown>();
  });

  it("defaults T to string for the legacy chat case", () => {
    expectTypeOf<AgentExecutor>().toEqualTypeOf<AgentExecutor<string>>();
    expectTypeOf<AgentReport>().toEqualTypeOf<AgentReport<string>>();
    expectTypeOf<SceneResult>().toEqualTypeOf<SceneResult<string>>();
  });
});
