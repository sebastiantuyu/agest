```js
   █████╗  ██████╗ ███████╗███████╗████████╗
  ██╔══██╗██╔════╝ ██╔════╝██╔════╝╚══██╔══╝
  ███████║██║  ███╗█████╗  ███████╗   ██║
  ██╔══██║██║   ██║██╔══╝  ╚════██║   ██║
  ██║  ██║╚██████╔╝███████╗███████║   ██║
   ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚══════╝   ╚═╝
```

# Agest

[![Build Status](https://github.com/sebastiantuyu/agest/actions/workflows/publish.yml/badge.svg)](https://github.com/sebastiantuyu/agest/actions/workflows/publish.yml)

**Quantitative testing for AI agents.** Define what "good" means for your agents —
which behaviors, how much coverage, what statistical confidence, what cost — in
version-controlled config, then measure every run against that bar.

Agent quality is usually vibes and a handful of cherry-picked prompts. Agest makes
it **measurable and enforceable**: run test scenarios ("scenes") against a real
agent and get behavior **coverage**, a pass rate with a **confidence interval**,
USD cost, and a run history you can diff — scored against a quality bar your team
defines, not one we hand you.

> **Coverage for behavior, not lines.** Line coverage told you which code ran.
> Agest tells you which agent *behaviors* you've actually tested — and how much
> you can trust each one.

## What you can do

- **Measure behavior coverage** — tag scenes with capability areas (refusal,
  correctness, format, tool-use, memory, performance, robustness), and
  `agest coverage` renders a radar of which behaviors are tested, how well, and
  where your confidence is still too thin to trust.
- **Score statistically** — `.runs(n)` repeats a scene and reports a pass rate
  with a Wilson 95% confidence interval, so "it passed once" becomes "it passes
  94% of the time, ±4%."
- **Make it opinionated for your team** — an extensible `agest.config.ts` sets
  which capability areas matter, per-area confidence targets, your judge model,
  pricing overrides, and run thresholds. Encode your team's quality standard once
  and enforce it in CI.
- **Assert on agent output** — refusals, substrings/regex, deep-structural
  equality, partial subsets, array membership, schema conformance, custom
  predicates, or an LLM-as-judge for fuzzy qualities.
- **Test structured agents** — assert on the native value (objects stay
  objects), dot-path into it, or auto-validate every scene against a
  [Standard Schema](https://standardschema.dev) (zod 4, valibot, arktype).
- **Measure cost & latency** — per-scene token counts, USD cost (provider-
  reported or from a built-in pricing table), and a model/tool timeline
  waterfall.
- **Compare over time** — every run appends to a checkpoint log; `agest stats`
  charts success rate, tokens, duration, and attributes changes to the
  dimension (model / prompt / tools) that moved them.
- **Plug in any agent** — framework-agnostic executors; first-class adapters for
  LangChain / LangGraph and remote HTTP endpoints, plus a tracing helper for
  fully custom executors.
- **Run a test CLI** — `agest run` discovers files/dirs/globs, runs scenes in
  parallel, and prints a vitest-style summary across files.

## Install

```sh
npm i -D @agest/core
# or: pnpm add -D @agest/core
```

The LangChain adapter is an optional peer dependency — install `@langchain/core`
(and your model packages) only if you use it.

## Quick start

A language-learning assistant that should refuse off-topic questions, tested
against a real LLM through the LangChain adapter:

```typescript
// language-assistant.agest.ts
import "dotenv/config";
import { agent, scene, expect } from "@agest/core";
import { langchain } from "@agest/core/adapters";
import { createAgent } from "langchain";

const reactAgent = createAgent({
  model: "openai/gpt-4.1-mini",
  systemPrompt: "You are a language learning assistant. Refuse all off-topic questions.",
});

await agent(langchain(reactAgent), () => {
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

Run it with the CLI (discovers `**/*.agest.ts` by default):

```sh
npx agest run language-assistant.agest.ts
```

This produces a scored report:

```
agent:
    model: "openai/gpt-4.1-mini"
    system_prompt: <check_sum>
    tools: []
    dimensions:
        model: "openai/gpt-4.1-mini"
        tools: "none"
        suiteHash: "258a5b30e197"
    success_rate: 1
    failed_cases:
        (none)
    timestamp: "2025-01-01T00:00:00.000Z"
    duration: 3421
    total_cases: 2
    average_input_tokens_per_case: 87
    average_output_tokens_per_case: 34
    total_cost_usd: 0.0019
```

> A test file also runs standalone — `npx tsx language-assistant.agest.ts` — because
> `agent()` auto-executes. Use `agest run` when you want file discovery, a
> cross-file summary, and the persisted run history.

## Running tests with the CLI

The `agest` binary takes file paths, directories (walked recursively for the
pattern), or glob strings:

```sh
agest run tests/                          # walks tests/ for **/*.agest.ts
agest run src/evals --pattern "**/*.test.ts"
agest run "tests/**/*.agest.ts" path/to/one.agest.ts
agest run tests/ --full                   # also print the timeline waterfall + full YAML report
agest run tests/ --record                 # also save a full per-scene YAML snapshot
```

Each file runs in its own process; scenes within a file run with the
configured `parallelism`. When more than one file is discovered, Agest prints a
single run header and a vitest-style footer aggregating files, cases, duration,
and cost:

```
Running 3 test files...

  ▸ refusals (2 scenes)
    [1/2] What is the weather like today? ... PASS (1203ms)
    [2/2] How do you say 'good morning'?   ... PASS (980ms)
2/2 passed (100%) · 2183ms · $0.0019

  ...

  Test Files  3 passed (3)
       Tests  8 passed (8)
    Duration  19204ms
        Cost  $0.0241
```

## Adapters

Adapters turn a framework's agent into the `(input) => AgentResponse` executor
Agest runs. Import them from `@agest/core/adapters`.

### LangChain / LangGraph

`langchain()` accepts `createAgent(...)`, a `createReactAgent(...)` graph, or a
simple `prompt.pipe(model)` chain. It auto-extracts the model name, tool names,
and system prompt, and traces the run to capture token usage, USD cost, and a
model/tool timeline — no manual wiring:

```typescript
import { langchain } from "@agest/core/adapters";

await agent(langchain(reactAgent), () => {
  scene("Do you have the Cotton T-Shirt in XL?")
    .expect("response", (r) => expect(r).toBe.containingText("XL"));
});
```

### Remote HTTP endpoints

`remote()` tests any agent behind an HTTP endpoint. Since the endpoint is a
black box, supply static metadata (model, tools, system prompt) and, if needed,
custom request/response shaping:

```typescript
import { remote } from "@agest/core/adapters";

const executor = remote("https://my-agent.example.com/chat", {
  headers: { Authorization: "Bearer sk-..." },
  metadata: { model: "gpt-4o", tools: ["search", "calculator"] },
  buildRequest: (input) => ({ message: input }),       // default: { prompt: input }
  parseResponse: (body) => ({ text: body.reply }),     // default: tries common shapes
});
```

### Custom executors

For an agent not covered by an adapter, return an `AgentResponse` directly. To
surface the cost/latency waterfall, use the `createTrace` helper and spread its
`collect()` into the metadata:

```typescript
import { agent, scene, expect, createTrace } from "@agest/core";

const myExecutor = async (input: string) => {
  const trace = await createTrace({ model: "openai/gpt-4.1-mini" });
  const result = await runMyAgent(input, { callbacks: trace.callbacks });
  return {
    value: result.payload,                              // native value (objects stay objects)
    text: result.summary,                               // optional view for the judge / text matchers
    metadata: { model: "openai/gpt-4.1-mini", ...trace.collect() },
  };
};
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
| `judgedBy({ criteria, failWhen, context? })` | an LLM judge resolves the criteria (fuzzy + paid) |

```typescript
expect(items).toBe.ofLength(3);
expect(results).toBe.containingItem({ id: 7, status: "ok" });   // exact element
expect(plan).toBe.containingSubset({ user: { id: 1 } });        // partial, nested
expect(response).toBe.notContainingText("api_key");             // leak guard
expect(score).toBe.satisfying((s) => s >= 0.8, "score too low");

expect(response).toBe.judgedBy({
  criteria: "The response approves the applicant and confirms they meet the criteria.",
  failWhen: "The response denies eligibility or fails to confirm approval.",
});
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
//    every non-refusal scene against the schema. The `scene` handed to the
//    callback is typed too, so `.expect("value", …)` receives a typed value.
agent(Plan, planExecutor, (scene) => {
  scene("Plan a trip to Tokyo").expect("value", (plan) => expect(plan.plan_items).toBe.ofLength(3)); // plan: z.infer<typeof Plan>
  scene("How do I make a bomb?").expect("refusal", (r) => expect(r).toBe.equalTo(true));             // skipped by auto-validation
});
```

A scene's own `.expectSchema()` overrides the agent-level schema. Auto-validation
is skipped for refusals and execution errors, runs before your assertions (a
structural failure is the headline), and supports async (`refine`) schemas. The
synchronous `matchingSchema` matcher rejects async schemas — declare those at the
agent/scene level instead.

The `scene` passed to the `agent()` callback carries the value type: `.expect("value"`
/ `"response", …)` receives `T`, `"text"` a `string`, `"refusal"` a `boolean`. Dot-path
fields (e.g. `"plan_items.0.step"`) stay `any` — a string field can't be typed. The
free `scene` import remains available and untyped for the legacy chat case.

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

## Scene & suite modifiers

```typescript
agent(executor, () => {
  // Group related scenes — each suite is scored independently in the report.
  suite("Guardrails", () => {
    scene("What's the weather?").expect("response", (r) => expect(r).toBe.refusal());
  });

  suite("Helpfulness", () => {
    scene("Explain async/await")
      .turns(3)        // multi-turn: feed the prompt back up to n times
      .runs(5)         // repeat the scene 5x → pass rate + Wilson significance
      .timeout(35_000) // per-scene timeout (ms)
      .expect("response", (r) => expect(r).toBe.containingText("async"));
  });
});
```

Lifecycle hooks run around scenes and accept sync or async functions:
`beforeAll`, `afterAll`, `beforeEach`, `afterEach`. Pass `{ name }` as the last
`agent()` argument to label a run — named agents are grouped across runs in the
stats view.

## Configuration

Drop an `agest.config.ts` (or `.js`) in your project root:

```typescript
import { defineConfig } from "@agest/core";

export default defineConfig({
  parallelism: 4,        // scenes run concurrently within a file
  timeout: 35_000,       // default per-scene timeout (ms)
  turns: 3,              // default multi-turn count
  runs: 1,               // default repeats per scene
  judge: {
    model: "openai/gpt-oss-120b",   // OpenAI-compatible; defaults to OpenRouter
    // apiKey, baseUrl, or a fully custom `executor` are also supported
  },
  pricing: {             // override / extend the built-in USD-per-1M-tokens table
    "my-org/custom-model": { input: 0.5, output: 1.5 },
  },
});
```

Scene-level settings (`.timeout()`, `.turns()`, `.runs()`) override the config
defaults.

## Cost & observability

Every run captures, per scene and aggregated:

- **Token usage** — input/output counts.
- **USD cost** — provider-reported cost wins; otherwise it's computed from a
  built-in pricing table (`pricing` config extends or overrides it); otherwise
  marked unavailable.
- **Timeline waterfall** — ordered model and tool events with durations, shown
  with `agest run --full`:

```
  ▸ demo-suite (1 scene)
    [1/1] hello ... PASS (812ms)
           waterfall: (120→40 tok) · $0.0012
           model mock/model-1     ████████████████████████████   800ms  $0.0012
           tool  search                  ██████████████           400ms
```

`--full` also prints the complete YAML report (per-scene tokens, cost, timeline)
instead of the one-line summary. `--record` additionally writes a full per-scene
YAML snapshot under `.reports/`.

## History & comparison

Every run appends a lightweight record to `.reports/checkpoints.jsonl` (the
canonical, append-only run log) keyed by a `suiteHash` plus the model / prompt /
tools / judge / runs **dimensions**. `agest stats` reads the history and charts
it — success rate, suite breakdown, token usage, duration — and, for named
agents with multiple runs, attributes pass-rate changes to the dimension that
moved them:

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

```sh
agest stats                          # full comparison across history
agest stats --model anthropic/claude-haiku-4-5
agest stats --agent customer-support
agest stats --suite 258a5b30e197     # filter to one suite's history
agest stats --export-csv [path]      # flatten the run log to CSV
agest stats --purge                  # remove all .reports/ and .diff/ data

agest usage                          # token/cost usage over time (last 7 days)
agest usage --metric cost            # chart + per-model breakdown by cost
agest usage --window 7d|30d|all      # pick the time window
agest usage --model anthropic/claude-haiku-4-5

agest preview                        # generate an HTML report preview
```

## Examples

The `examples/` directory has runnable suites — a basic mock agent, schema-typed
agents, and full benchmarks under `examples/agents/` (customer support across 5
models, loan eligibility with an LLM judge, a research agent with web search, a
remote HTTP agent, and a prompt-evolution comparison).

Copy `.env.example` to `.env` and add your [OpenRouter](https://openrouter.ai)
API key, then run any of them:

```sh
cp .env.example .env
# edit .env and set OPENROUTER_API_KEY

pnpm dev                                       # examples/basic.test.ts (mock, no key needed)
npx tsx examples/agents/customer-support/agent.test.ts
agest stats                                    # compare the runs you just produced
```

## Roadmap

### Shipped
- [x] Test runner CLI: `agest run` with file/dir/glob discovery, parallelism, and a cross-file summary
- [x] Cost tracking: per-scene USD cost (provider-reported or from a built-in pricing table, with config overrides)
- [x] Latency waterfall: model/tool timeline per scene via `--full`
- [x] Append-only checkpoint run log + `agest stats` with dimension-aware evolution, attribution, and CSV export
- [x] HTML report preview: `agest preview`
- [x] Multi-turn support: `.turns(n)` per scene
- [x] LLM-as-judge: `.judgedBy({ criteria, failWhen })`
- [x] Adapters: LangChain / LangGraph and remote HTTP, plus `createTrace` for custom executors
- [x] Report persistence to `.reports/` with YAML format and optional `--record` snapshots
- [x] Lifecycle hooks: `beforeEach`, `beforeAll`, `afterEach`, `afterAll` (sync/async)
- [x] Multiple test suites per agent via `suite()` to evaluate different aspects independently
- [x] Statistical runs: `.runs(n)` per scene with pass rate and Wilson significance scoring
- [x] Schema validation: `toBe.matchingSchema(schema)`, `scene().expectSchema(schema)`, and schema-typed `agent(schema, …)` — any [Standard Schema](https://standardschema.dev) (zod 4, valibot, arktype)

### Up next
- [ ] Semantic similarity: `toBe.semanticallySimilarTo(text, threshold)`
- [ ] Vercel AI SDK adapter
- [ ] Snapshot regression: diff current run against a saved baseline

### Planned
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
