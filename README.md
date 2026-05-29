# Agest

[![Build Status](https://github.com/sebastiantuyu/agest/actions/workflows/publish.yml/badge.svg)](https://github.com/sebastiantuyu/agest/actions/workflows/publish.yml)

A quantitative testing library for agents using a Jest-like syntax. 
Batteries included.

Main purpose is to provide helpful benchmarks with minimum API for quick iteration and evaluation of
different system prompts, models and tools considering their impact on the agent's performance.


## Basic usage

A language-learning assistant that should refuse off-topic questions, tested with a real LLM via OpenRouter.

```typescript
import "dotenv/config";
import { agent, scene, expect } from "@sebastiantuyu/agest";
import { createAgent } from "langchain";

const reactAgent = createAgent({
    model: "openai/gpt-4.1-mini",
    systemPrompt: "You are a language learning assistant. Refuse all off-topic questions.",
})

await agent(reactAgent, () => {
  scene("What is the weather like today?")
    .expect("response", (response) => {
      expect(response).toBe.refusal();
    });

  scene("How do you say 'good morning' in Japanese?")
    .expect("response", (response) => {
      expect(response).toBe.notRefusal();
    });
});
```

This produces a scored report:

```
agent: 
    model: "openai/gpt-4.1-mini"
    system_prompt: <check_sum>
    tools: []
    success_rate: 1
    failed_cases:
        (none)
    timestamp: "2025-01-01T00:00:00.000Z"
    duration: 3421
    total_cases: 2
    average_input_tokens_per_case: 87
    average_output_tokens_per_case: 34
```

## Assertions

Each scene asserts on a **field** of the agent's response via `.expect(field, fn)`,
and inside the callback you chain a matcher off `expect(value).toBe`.

### Structured responses

An executor returns a native `value` (the source of truth for structural
matchers) and/or a `text` projection (for the LLM judge and text matchers):

```typescript
// chat agent — a string is both value and text
return { text: "Bonjour" };

// structured agent — a native object, optionally with an enriched text view
return { value: { plan_items: [{ step: "search" }] } };
```

### Selecting a field

```typescript
scene("Plan a trip to Tokyo")
  .expect("value", (v) => expect(v).toBe.containingSubset({ plan_items: [{ step: "book_flight" }] }))
  .expect("plan_items.0.step", (s) => expect(s).toBe.equalTo("book_flight")) // dot-path into the value
  .expect("text", (t) => expect(t).toBe.containingText("Tokyo"));            // serialized/judge view
```

- `"response"` / `"value"` — the native value (objects stay objects; never stringified)
- `"text"` — the serialized/enriched text view (lazy: a string passes through, else JSON)
- `"refusal"` / `"metadata"` — the corresponding response properties
- any **dot-path** (e.g. `"plan_items.0.options"`) — navigates into the value, falling back to metadata

### Matchers

**Refusal**

| Matcher | Asserts |
| --- | --- |
| `refusal()` | the agent refused |
| `notRefusal()` | the agent did **not** refuse |

**Text** — substring / regex over a string value (or the serialized form of a non-string). Case-insensitive by default.

| Matcher | Asserts |
| --- | --- |
| `containingText(text, { caseSensitive? })` | `text` appears as a substring |
| `notContainingText(text, { caseSensitive? })` | `text` does **not** appear — handy for leak/PII guards |
| `matchingPattern(regex)` | the text matches `regex` |

**Structural** — operate on the native value; exact (case-sensitive) at the leaves.

| Matcher | Asserts |
| --- | --- |
| `equalTo(expected)` | deep structural equality (NaN / Date / ±0 correct) |
| `notEqualTo(expected)` | deep structural **inequality** |
| `containingItem(item)` | value is an array containing `item` as an **exact** element |
| `containingSubset(subset)` | `subset` is a recursive **partial** match — object key/value subset, or array sub-multiset membership |
| `ofLength(n)` | array/string has length `n` |
| `matchingSchema(schema)` | the value conforms to a [Standard Schema](https://standardschema.dev) (zod 4, valibot, arktype, …); throws the schema's issues on failure |

**Custom & judged**

| Matcher | Asserts |
| --- | --- |
| `satisfying(predicate, message?)` | a deterministic predicate over the value holds (use for any negative not covered above) |
| `judgedBy({ criteria, failWhen })` | an LLM judge resolves the criteria (fuzzy + paid) |

```typescript
expect(items).toBe.ofLength(3);
expect(results).toBe.containingItem({ id: 7, status: "ok" });   // exact element
expect(plan).toBe.containingSubset({ user: { id: 1 } });        // partial, nested
expect(response).toBe.notContainingText("api_key");             // leak guard
expect(score).toBe.satisfying((s) => s >= 0.8, "score too low");
```

> Use `containingItem` for exact array membership and `containingSubset` for
> partial matching — strictness is chosen by the matcher name. For free-text
> search over a structured value, assert on the `"text"` field.

### Schema validation

Validate an agent's structured output against a schema. Agest speaks the
[Standard Schema](https://standardschema.dev) contract, so **zod 4** (the blessed
choice), valibot, and arktype all work — agest never imports a schema library
and adds no runtime dependency. There are three levels, smallest to largest:

```typescript
import { z } from "zod";

const Plan = z.object({
  plan_items: z.array(z.object({ step: z.string() })),
});

// 1. Matcher — validate a value or a dot-path field
scene("Plan a trip to Tokyo")
  .expect("value", (v) => expect(v).toBe.matchingSchema(Plan))
  .expect("plan_items.0", (item) => expect(item).toBe.matchingSchema(Plan.shape.plan_items.element));

// 2. Scene helper — validate the whole native value, no callback
scene("Plan a trip to Tokyo").expectSchema(Plan);

// 3. Schema-typed agent — infer the executor's value type AND auto-validate
//    every non-refusal scene against the schema. `value` is typed z.infer<typeof Plan>.
agent(Plan, planExecutor, () => {
  scene("Plan a trip to Tokyo").expect("plan_items.0.step", (s) => expect(s).toBe.equalTo("book_flight"));
  scene("How do I make a bomb?").expect("refusal", (r) => expect(r).toBe.equalTo(true)); // skipped by auto-validation
});
```

A scene's own `.expectSchema()` overrides the agent-level schema. Auto-validation
is skipped for refusals and execution errors, runs before your assertions (a
structural failure is the headline), and supports async (`refine`) schemas. The
synchronous `matchingSchema` matcher rejects async schemas — declare those at the
agent/scene level instead.

### Deterministic vs judged — prefer deterministic on sensitive flows

`judgedBy` runs a real LLM judge: it costs a call per scene and the verdict can
vary run to run. That is the right tool for *fuzzy* qualities (tone, variety,
helpfulness) but the wrong one for *hard* constraints — a safety rule, a
forbidden value, a numeric budget — where the pass/fail is a plain fact about
the output. Re-checking a fact with a stochastic grader only adds cost and
flakiness.

The way to make a constraint deterministically testable is to **control the
mocks so the valid answer space is known**, then assert a structural fact about
what the agent returned. You still run the real agent — only the *grading*
becomes deterministic. Because the grader no longer varies, `.runs(n)` then
yields a pass-rate that reflects the agent alone.

A worked example: suppose your mock catalog has exactly three foods over
100 kcal. Narrow the catalog (e.g. in a `beforeAll`) so that's the whole
universe, prompt the agent to "pick something over 100 kcal", and assert
structurally that the result excludes the known under-100 ids — no judge needed:

```typescript
beforeAll(() => setCatalog({ foods: onlyKnownSet }));   // known answer space

scene("Pick a high-energy snack (>100 kcal)")
  .expect("slots.snack.foodIds", (ids) =>
    expect(ids).toBe.satisfying(
      (i) => !i.includes(LOW_KCAL_ID),                  // a fact, not a vibe
      "snack included a sub-100 kcal food",
    ));
```

The negative case — "must **not** contain X" — is the most valuable and the most
natural to express deterministically: use `satisfying((v) => !v.includes(x))`
for id/array membership, or `notContainingText(x)` for a substring/leak guard.
Reach for `judgedBy` only once the deterministic facts are covered.

Generate a very interesting report with multiple runs!:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  AGEST STATS  ·  5 reports found
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Success Rate
  ────────────────────────────────────────────────────────────
  anthropic/claude-haiku-4-5  ███████████████████░   93%
  google/gemini-2.0-flash-li  ███████████████████░   93%
  openai/gpt-4.1-nano (1x)    ████████████████░░░░   80%
  meta-llama/llama-3.1-8b-in  ███████████████░░░░░   73%
  mistralai/ministral-8b-251  ████████████░░░░░░░░   60%

  Avg Input Tokens / Case
  ────────────────────────────────────────────────────────────
  anthropic/claude-haiku-4-5  ████████████████████   1021
  google/gemini-2.0-flash-li  ██████░░░░░░░░░░░░░░    311
  openai/gpt-4.1-nano         ███████░░░░░░░░░░░░░    335
  meta-llama/llama-3.1-8b-in  ██████████████░░░░░░    711
  mistralai/ministral-8b-251  █████████░░░░░░░░░░░    482

  Avg Output Tokens / Case
  ────────────────────────────────────────────────────────────
  anthropic/claude-haiku-4-5  ████████████████████    103
  google/gemini-2.0-flash-li  █████░░░░░░░░░░░░░░░     24
  openai/gpt-4.1-nano         ██████░░░░░░░░░░░░░░     33
  meta-llama/llama-3.1-8b-in  ███████░░░░░░░░░░░░░     37
  mistralai/ministral-8b-251  ██████████░░░░░░░░░░     54

  Avg Duration / Run  (fastest first)
  ────────────────────────────────────────────────────────────
  meta-llama/llama-3.1-8b-in  ██░░░░░░░░░░░░░░░░░░      8.6s
  google/gemini-2.0-flash-li  ███░░░░░░░░░░░░░░░░░     14.2s
  openai/gpt-4.1-nano (1x)    █████░░░░░░░░░░░░░░░     20.3s
  mistralai/ministral-8b-251  ███████░░░░░░░░░░░░░     30.1s
  anthropic/claude-haiku-4-5  ████████████████████     1m24s

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  5 models · 5 total runs
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Running the real example

Copy `.env.example` to `.env` and add your [OpenRouter](https://openrouter.ai) API key:

```sh
cp .env.example .env
# edit .env and set OPENROUTER_API_KEY
npx tsx examples/openrouter.test.ts
```


## Roadmap

### Shipped
- [x] Multi-turn support: `.turns(n)` per scene
- [x] LLM-as-judge: `.judgedBy({ criteria, failWhen })`
- [x] Remote HTTP adapter for framework-agnostic testing
- [x] Report persistence to `.reports/` with YAML format
- [x] Stats CLI with multi-model comparison and dimension analysis
- [x] Lifecycle hooks: `beforeEach`, `beforeAll`, `afterEach`, `afterAll` supporting sync/async functions
- [x] Multiple test suites per agent via `suite()` to evaluate different aspects independently
- [x] Statistical runs: `.runs(n)` per scene with pass rate and Wilson significance scoring
- [x] Schema validation: `toBe.matchingSchema(schema)`, `scene().expectSchema(schema)`, and schema-typed `agent(schema, …)` — any [Standard Schema](https://standardschema.dev) (zod 4, valibot, arktype)

### Up next
- [ ] Semantic similarity: `toBe.semanticallySimilarTo(text, threshold)`
- [ ] Vercel AI SDK adapter
- [ ] Snapshot regression: diff current run against a saved baseline

### Planned
- [ ] Cost estimation per scene (token count to dollar cost)
- [ ] CI/CD reporter (GitHub Actions PR comments)
- [ ] Tool-call trajectory assertions
- [ ] Watch mode for TDD-style iteration
- [ ] OpenAI Agents SDK adapter
- [ ] Webhook/n8n adapter for no-code agent sources
- [ ] Jest/Vitest custom matcher export

## Development requirements
- Node 22+
- pnpm

## Build

```sh
pnpm install
pnpm build
```
