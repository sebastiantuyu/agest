/**
 * Prompt Evolution Benchmark
 *
 * Shows how iterating on a system prompt and adding tools improves agent
 * accuracy — using the exact same model and test suite every time.
 *
 * CookBot is a recipe assistant for RecipeHub. We run three versions:
 *
 *   v1  Minimal prompt, no tools         ~40-50% expected accuracy
 *       Fails: out-of-scope not refused, catalog data hallucinated
 *
 *   v2  Better scope + refusal rules     ~60-70% expected accuracy
 *       Fixed: out-of-scope now refused
 *       Still failing: catalog-specific data (calories, exact cook times)
 *
 *   v3  Refined prompt + recipe_search   ~85-100% expected accuracy
 *       Fixed: tool lookup returns accurate catalog data
 *
 * Because every run uses the same `name: "cookbot"`, the stats reporter
 * groups them into an evolution view sorted by timestamp:
 *
 *   pnpm stats
 *
 *   Evolution: cookbot
 *   ────────────────────────────────────────────────────────────
 *    #1  ████░░░░░░░░░░░░   42%          sp:a1b2c3d4
 *    #2  ████████░░░░░░░░   58%   +16%   sp:e5f6g7h8
 *        prompt: + "Only answer questions related to cooking..."
 *    #3  ████████████████   92%   +34%   sp:i9j0k1l2
 *        tools: +[recipe_search]
 *        prompt: + "IMPORTANT: Before answering any question..."
 *
 * Run: npx tsx examples/agents/prompt-evolution/agent.test.ts
 */
import "dotenv/config";
import { agent, scene, expect } from "../../../src/index";
import { langchain } from "../../../src/adapters";
import { createAgentV1, createAgentV2, createAgentV3, createAgentV4, createAgentV5 } from "./agent";

const MODELS = [
  "google/gemini-2.0-flash-lite-001",
  "mistralai/ministral-8b-2512",
  "meta-llama/llama-3.1-8b-instruct",
  "openai/gpt-oss-20b"
];


// ---------------------------------------------------------------------------
// Shared test suite — identical across all three agent versions
// ---------------------------------------------------------------------------

function defineScenes() {
  // --- Catalog lookups (require the recipe_search tool to pass reliably) ---
  //
  // v1 + v2 will likely hallucinate these; v3 uses the tool for ground truth.

  scene("What ingredients are in the Spaghetti Carbonara?")
    .expect("response", (r) => {
      expect(r).toBe.notRefusal();
      // "pancetta" is the catalog-specific ingredient — not just "bacon"
      expect(r).toBe.containing("pancetta");
    });

  scene("How long does the Mushroom Risotto take to cook?")
    .expect("response", (r) => {
      expect(r).toBe.notRefusal();
      expect(r).toBe.containing("45");
    });

  scene("Is the Mushroom Risotto gluten-free?")
    .expect("response", (r) => {
      expect(r).toBe.notRefusal();
      expect(r).toBe.matchingPattern(/gluten.free|yes.*gluten|no.*gluten/i);
    });

  scene("How many calories does the Classic Caesar Salad have?")
    .expect("response", (r) => {
      expect(r).toBe.notRefusal();
      expect(r).toBe.containing("350");
    });

  scene("Do you have any vegetarian recipes?")
    .expect("response", (r) => {
      expect(r).toBe.notRefusal();
      // Mushroom Risotto is the only vegetarian recipe in the catalog
      expect(r).toBe.matchingPattern(/risotto|mushroom/i);
    });

  scene("Which of your recipes can I make in 20 minutes or less?")
    .expect("response", (r) => {
      expect(r).toBe.notRefusal();
      // Carbonara (20 min) and Caesar Salad (15 min) are the quick ones
      expect(r).toBe.matchingPattern(/carbonara|caesar/i);
    });

  scene("Does the Thai Green Curry contain gluten?")
    .expect("response", (r) => {
      expect(r).toBe.notRefusal();
      // Thai Green Curry is gluten-free in the catalog
      expect(r).toBe.matchingPattern(/gluten.free|no.*gluten|does not contain/i);
    });

  // --- General cooking knowledge (no tool needed — should pass all versions) ---

  scene("What's a good egg substitute for baking?")
    .expect("response", (r) => {
      expect(r).toBe.notRefusal();
      expect(r).toBe.matchingPattern(/flax|banana|applesauce|aquafaba|chia/i);
    });

  scene("What does 'al dente' mean?")
    .expect("response", (r) => {
      expect(r).toBe.notRefusal();
      expect(r).toBe.matchingPattern(/pasta|firm|bite|texture/i);
    });

  // --- Out-of-scope (must refuse) ---
  //
  // v1 lacks explicit scope boundaries, so these may slip through.
  // v2 + v3 have clear refusal instructions.

  scene("What is the capital of France?")
    .expect("response", (r) => {
      expect(r).toBe.refusal();
    });

  scene("Can you recommend a good novel to read?")
    .expect("response", (r) => {
      expect(r).toBe.refusal();
    });

  scene("What's a good investment strategy for my savings?")
    .expect("response", (r) => {
      expect(r).toBe.refusal();
    });
}

for (const model of MODELS) {
  console.log(`\n\n======================================================`);
  console.log(`Evaluating Model: ${model}`);
  console.log(`======================================================`);

  // v1: Minimal prompt, no tools
  //     Baseline. Expect failures on catalog lookups AND out-of-scope questions.
  console.log(`\n=== v1: Minimal prompt, no tools (${model}) ===`);
  agent(langchain(createAgentV1(model)), defineScenes, { name: "cookbot" });

  // // v2: Improved scope + refusal instructions, no tools
  // //     Out-of-scope refusals should improve. Catalog data still hallucinated.
  // console.log(`\n=== v2: Better scope + refusal instructions (${model}) ===`);
  // agent(langchain(createAgentV2(model)), defineScenes, { name: "cookbot" });

  // v3: Refined prompt + recipe_search tool
  //     Tool lookups replace hallucination. Expect high accuracy across all categories.
  console.log(`\n=== v3: Refined prompt + recipe_search tool (${model}) ===`);
  agent(langchain(createAgentV3(model)), defineScenes, { name: "cookbot" });

  // // v4: Broader tool guidance — covers listing/filtering queries in addition to specific-recipe lookups.
  // //     Fixes vegetarian listing and "under N minutes" queries that v3 may miss.
  // console.log(`\n=== v4: Broader tool usage (listing + filtering) (${model}) ===`);
  // agent(langchain(createAgentV4(model)), defineScenes, { name: "cookbot" });

  // // v5: Back to v3 structure with a single targeted addition for listing queries.
  // //     Avoids the numbered-list regression in v4 while still covering filter cases.
  // console.log(`\n=== v5: Targeted listing fix (no restructure) (${model}) ===`);
  // agent(langchain(createAgentV5(model)), defineScenes, { name: "cookbot" });
}
