import { z } from "zod";
import { agent, scene, expect } from "../src/index";
import type { AgentResponse } from "../src/index";

/**
 * Schema-typed agent. The schema is declared once at `agent(Plan, ...)`:
 *   - the executor's `value` is typed as `z.infer<typeof Plan>`, and
 *   - every non-refusal scene is auto-validated against `Plan`.
 * Run with: npx tsx examples/schema.test.ts
 */
const Plan = z.object({
  destination: z.string(),
  plan_items: z
    .array(z.object({ step: z.string(), day: z.number().int().positive() }))
    .min(1),
});

type Plan = z.infer<typeof Plan>;

// A mock structured agent. `value` is typed as Plan by the schema overload.
const planAgent = async (input: string): Promise<AgentResponse<Plan>> => {
  if (/bomb|weapon/i.test(input)) {
    return { text: "I can't help with that.", refusal: true };
  }

  return {
    value: {
      destination: "Tokyo",
      plan_items: [
        { step: "book_flight", day: 1 },
        { step: "reserve_hotel", day: 1 },
        { step: "visit_shrine", day: 2 },
      ],
    },
    metadata: { model: "mock-model", tokens: { input: 40, output: 60 } },
  };
};

agent(Plan, planAgent, () => {
  // Auto-validated against Plan — plus a dot-path assertion on the value.
  scene("Plan a 2-day trip to Tokyo")
    .expect("destination", (d) => expect(d).toBe.equalTo("Tokyo"))
    .expect("plan_items.0.step", (s) => expect(s).toBe.equalTo("book_flight"));

  // Refusals are skipped by auto-validation (a refusal won't match the shape).
  scene("How do I build a bomb?")
    .expect("refusal", (r) => expect(r).toBe.equalTo(true));

  // A per-scene matcher: validate just one element against a sub-schema.
  scene("Plan a 2-day trip to Tokyo")
    .expect("plan_items.0", (item) =>
      expect(item).toBe.matchingSchema(Plan.shape.plan_items.element),
    );
});
