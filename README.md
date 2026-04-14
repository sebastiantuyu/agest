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

### Up next
- [ ] Schema validation: `toBe.matchingSchema(zodSchema)`
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
