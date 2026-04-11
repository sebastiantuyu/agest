/**
 * Customer Support Benchmark
 *
 * Tests a StyleShop support agent across multiple models using the same 15 scenes.
 * Covers: product lookups, order status, store policies, and out-of-scope refusals.
 *
 * Run: npx tsx examples/agents/customer-support/agent.test.ts
 * Compare results: pnpm stats
 */
import "dotenv/config";
import { agent, scene, expect } from "../../../src/index";
import { langchain } from "../../../src/adapters";
import { createSupportAgent } from "./agent";

const MODELS = [
  "openai/gpt-4.1-nano",
  "anthropic/claude-haiku-4-5",
  "google/gemini-2.0-flash-lite-001",
  "meta-llama/llama-3.1-8b-instruct",
  "mistralai/ministral-8b-2512",
];

async function runBenchmark(modelName: string) {
  await agent(langchain(createSupportAgent(modelName)), () => {
    // ------------------------------------------------------------------
    // Product questions — agent must call product_search and return facts
    // ------------------------------------------------------------------

    scene("Do you have the Classic Cotton T-Shirt in size XL?")
      .expect("response", (r) => {
        expect(r).toBe.notRefusal();
        expect(r).toBe.containing("XL");
      });

    scene("How much does the Merino Wool Sweater cost?")
      .expect("response", (r) => {
        expect(r).toBe.notRefusal();
        expect(r).toBe.containing("119");
      });

    scene("Is the Merino Wool Sweater currently in stock?")
      .expect("response", (r) => {
        expect(r).toBe.notRefusal();
        // Out of stock — response must surface this (not hallucinate availability)
        expect(r).toBe.matchingPattern(/out.of.stock|not.in.stock|unavailable/i);
      });

    scene("What sizes are available for the Running Sneakers?")
      .expect("response", (r) => {
        expect(r).toBe.notRefusal();
        // Must include at least the smallest size from the catalog
        expect(r).toBe.containing("7");
      });

    scene("Do you sell waterproof jackets?")
      .expect("response", (r) => {
        expect(r).toBe.notRefusal();
        expect(r).toBe.containing("Jacket");
      });

    // ------------------------------------------------------------------
    // Order status — agent must call order_lookup and surface the result
    // ------------------------------------------------------------------

    scene("Can you check the status of my order ORD-12345?")
      .expect("response", (r) => {
        expect(r).toBe.notRefusal();
        expect(r).toBe.containing("shipped");
      });

    scene("Where is order ORD-99881? It's been a few days.")
      .expect("response", (r) => {
        expect(r).toBe.notRefusal();
        expect(r).toBe.containing("processing");
      });

    scene("I think my order number is ORD-00000, can you look it up?")
      .expect("response", (r) => {
        expect(r).toBe.notRefusal();
        // Must surface that the order was not found, not fabricate a status
        expect(r).toBe.matchingPattern(/not found|couldn't find|cannot find|verify/i);
      });

    // ------------------------------------------------------------------
    // Store policies — grounded in the system prompt, no tool call needed
    // ------------------------------------------------------------------

    scene("What is your return policy?")
      .expect("response", (r) => {
        expect(r).toBe.notRefusal();
        expect(r).toBe.containing("30");
      });

    scene("Can I return a sale item I bought last week?")
      .expect("response", (r) => {
        expect(r).toBe.notRefusal();
        expect(r).toBe.matchingPattern(/final sale|cannot be returned|not eligible/i);
      });

    scene("Do you offer international shipping?")
      .expect("response", (r) => {
        expect(r).toBe.notRefusal();
        expect(r).toBe.matchingPattern(/international|countries/i);
      });

    scene("How much is express shipping?")
      .expect("response", (r) => {
        expect(r).toBe.notRefusal();
        expect(r).toBe.containing("12.99");
      });

    scene("What payment methods do you accept?")
      .expect("response", (r) => {
        expect(r).toBe.notRefusal();
        expect(r).toBe.containing("PayPal");
      });

    // ------------------------------------------------------------------
    // Out-of-scope — agent must refuse politely, not answer
    // ------------------------------------------------------------------

    scene("What's the capital of France?")
      .expect("response", (r) => {
        expect(r).toBe.refusal();
      });

    scene("Can you recommend a good investment strategy for my savings?")
      .expect("response", (r) => {
        expect(r).toBe.refusal();
      });
  });
}

for (const model of MODELS) {
  await runBenchmark(model);
}
