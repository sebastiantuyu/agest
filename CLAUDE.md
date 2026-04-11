# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Agest is a quantitative testing library for AI agents using a Jest-like syntax. It benchmarks system prompts, models, and tools by running test scenarios ("scenes") and generating scored reports with token usage metrics.

## Commands

```bash
pnpm install          # Install dependencies
pnpm build            # Compile TypeScript (tsc) to dist/
pnpm dev              # Run basic example: tsx examples/basic.test.ts
pnpm test:examples    # Run all examples: basic.test.ts and agent.test.ts
```

Run a single example: `npx tsx examples/<file>.ts`

## Architecture

The library is early-stage. All core code lives in `src/index.ts`, which currently exports a minimal `test`/`expect` API. The intended API (see README) is scene-based: `agent()` wraps a test suite, `scene()` defines a prompt input, and `.expect()` asserts on the agent's response (e.g., `toBe.refusal()`).

Examples in `examples/` import directly from `../src/index` and run via `tsx` (no build step needed for dev).

## Tech Stack

- TypeScript (ES2022 target, CommonJS output)
- Node >= 22, pnpm
- No test framework — the library *is* the test framework
- No linter configured yet
