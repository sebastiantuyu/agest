import "dotenv/config";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { createAgent } from "langchain";

// ---------------------------------------------------------------------------
// Mock catalog for RecipeHub
// ---------------------------------------------------------------------------

const RECIPES: Record<
  string,
  {
    name: string;
    ingredients: string[];
    cookTime: number;
    calories: number;
    dietary: { vegan: boolean; vegetarian: boolean; glutenFree: boolean };
    tags: string[];
  }
> = {
  "RCP-001": {
    name: "Spaghetti Carbonara",
    ingredients: ["spaghetti", "eggs", "pancetta", "parmesan", "black pepper"],
    cookTime: 20,
    calories: 650,
    dietary: { vegan: false, vegetarian: false, glutenFree: false },
    tags: ["pasta", "italian", "quick"],
  },
  "RCP-002": {
    name: "Mushroom Risotto",
    ingredients: [
      "arborio rice",
      "mushrooms",
      "parmesan",
      "butter",
      "white wine",
      "vegetable broth",
    ],
    cookTime: 45,
    calories: 480,
    dietary: { vegan: false, vegetarian: true, glutenFree: true },
    tags: ["rice", "italian", "vegetarian"],
  },
  "RCP-003": {
    name: "Thai Green Curry",
    ingredients: [
      "chicken",
      "coconut milk",
      "green curry paste",
      "bamboo shoots",
      "Thai basil",
      "fish sauce",
    ],
    cookTime: 30,
    calories: 520,
    dietary: { vegan: false, vegetarian: false, glutenFree: true },
    tags: ["thai", "curry", "spicy"],
  },
  "RCP-004": {
    name: "Classic Caesar Salad",
    ingredients: [
      "romaine lettuce",
      "croutons",
      "parmesan",
      "anchovies",
      "caesar dressing",
    ],
    cookTime: 15,
    calories: 350,
    dietary: { vegan: false, vegetarian: false, glutenFree: false },
    tags: ["salad", "american", "quick"],
  },
  "RCP-005": {
    name: "Chocolate Lava Cake",
    ingredients: ["dark chocolate", "butter", "eggs", "sugar", "flour"],
    cookTime: 25,
    calories: 420,
    dietary: { vegan: false, vegetarian: true, glutenFree: false },
    tags: ["dessert", "chocolate"],
  },
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const recipeSearchTool = tool(
  async ({ query, tag }) => {
    const hits = Object.entries(RECIPES).filter(([_, r]) => {
      const matchesQuery = r.name.toLowerCase().includes(query.toLowerCase());
      const matchesTag = tag ? r.tags.includes(tag.toLowerCase()) : false;
      return matchesQuery || matchesTag;
    });

    if (hits.length === 0) return "No recipes found matching that query.";

    return hits
      .map(
        ([id, r]) =>
          `${r.name} (${id}): ${r.cookTime} min | ${r.calories} cal` +
          ` | Ingredients: ${r.ingredients.join(", ")}` +
          ` | Dietary: vegan=${r.dietary.vegan}, vegetarian=${r.dietary.vegetarian}, gluten-free=${r.dietary.glutenFree}`
      )
      .join("\n");
  },
  {
    name: "recipe_search",
    description:
      "Search the RecipeHub catalog. Use this for any question about a specific recipe's " +
      "ingredients, cook time, calories, or dietary info. Also accepts tag filters like " +
      "'vegetarian', 'quick', 'spicy', 'pasta', etc.",
    schema: z.object({
      query: z.string().describe("Recipe name or keyword to search for"),
      tag: z
        .string()
        .optional()
        .describe(
          "Tag to filter by: vegetarian, vegan, quick, pasta, rice, salad, dessert, spicy, etc."
        ),
    }),
  }
);

// ---------------------------------------------------------------------------
// System prompts — three iterations of the same agent
// ---------------------------------------------------------------------------

// v1: Bare minimum — no scope boundary, no tool guidance.
//
// Expected failures:
//   - Out-of-scope questions may be answered (model tries to be "helpful")
//   - Catalog-specific data is hallucinated (no tool to look it up)
const SYSTEM_PROMPT_V1 =
  "You are a helpful cooking assistant. Answer questions about cooking and recipes.";

// v2: Improved scope + explicit refusal instructions, but still no tools.
//
// Fixed vs v1:
//   - Out-of-scope questions are now politely refused
// Still failing:
//   - Catalog-specific data (calories, exact cook times, ingredients) is still
//     hallucinated because there's no tool to retrieve it
const SYSTEM_PROMPT_V2 =
  "You are CookBot, a recipe assistant for RecipeHub. You help users with:\n" +
  "- Finding and exploring recipes\n" +
  "- Ingredients, cook times, and dietary information\n" +
  "- Cooking techniques and substitutions\n\n" +
  "Only answer questions related to cooking, recipes, and food preparation. " +
  "Politely decline any request outside this scope — including diet or health advice, " +
  "restaurant recommendations, shopping, or general knowledge questions.";

// v3: Full prompt + explicit tool guidance.
//
// Fixed vs v2:
//   - recipe_search tool returns accurate catalog data instead of hallucinated values
//   - Stronger instruction to always look up before answering
const SYSTEM_PROMPT_V3 =
  "You are CookBot, a recipe assistant for RecipeHub. You help users with:\n" +
  "- Finding and exploring recipes\n" +
  "- Ingredients, cook times, and dietary information\n" +
  "- Cooking techniques and substitutions\n\n" +
  "IMPORTANT: Before answering any question about a specific recipe's ingredients, " +
  "cook time, calories, or dietary properties, you MUST call the recipe_search tool. " +
  "Never guess or recall catalog data from memory — always look it up.\n\n" +
  "Only answer questions related to cooking, recipes, and food preparation. " +
  "Politely decline any request outside this scope — including diet or health advice, " +
  "restaurant recommendations, shopping, or general knowledge questions.";

// v4: Minimal extension of v3 — adds tag-based search for listing/filtering queries.
//
// Fixed vs v3:
//   - "Do you have any vegetarian recipes?" now triggers tool with tag="vegetarian"
//   - "Recipes under 20 min" now triggers tool with tag="quick"
//   - Refusal and general-knowledge behaviour unchanged (no restructuring)
const SYSTEM_PROMPT_V4 =
  "You are CookBot, a recipe assistant for RecipeHub. You help users with:\n" +
  "- Finding and exploring recipes\n" +
  "- Ingredients, cook times, and dietary information\n" +
  "- Cooking techniques and substitutions\n\n" +
  "IMPORTANT: Before answering any question about a specific recipe's ingredients, " +
  "cook time, calories, or dietary properties, you MUST call the recipe_search tool. " +
  "Also call recipe_search when a user asks to list or find recipes by category or time " +
  "(e.g. 'any vegetarian recipes?', 'recipes under 20 minutes') — use the tag parameter " +
  "with values like: vegetarian, vegan, quick, pasta, rice, salad, dessert, spicy, italian, thai. " +
  "Never guess or recall catalog data from memory — always look it up.\n\n" +
  "Only answer questions related to cooking, recipes, and food preparation. " +
  "Politely decline any request outside this scope — including diet or health advice, " +
  "restaurant recommendations, shopping, or general knowledge questions.";

// v5: Back to v3 structure, single targeted addition for listing queries.
//
// Fixed vs v4 (which regressed):
//   - Removed numbered list that confused the refusal boundary
//   - One extra sentence appended to the v3 IMPORTANT block:
//     listing/filtering queries also require a tool call with tag parameter
const SYSTEM_PROMPT_V5 =
  "You are CookBot, a recipe assistant for RecipeHub. You help users with:\n" +
  "- Finding and exploring recipes\n" +
  "- Ingredients, cook times, and dietary information\n" +
  "- Cooking techniques and substitutions\n\n" +
  "IMPORTANT: Before answering any question about a specific recipe's ingredients, " +
  "cook time, calories, or dietary properties, you MUST call the recipe_search tool. " +
  "When a user asks to list or find recipes by diet or speed (e.g. 'vegetarian recipes', " +
  "'recipes under 20 minutes'), call recipe_search with the matching tag " +
  "(vegetarian, vegan, quick, pasta, salad, dessert, spicy). " +
  "Never guess or recall catalog data from memory — always look it up.\n\n" +
  "Only answer questions related to cooking, recipes, and food preparation. " +
  "Politely decline any request outside this scope — including diet or health advice, " +
  "restaurant recommendations, shopping, or general knowledge questions.";

// ---------------------------------------------------------------------------
// Agent factory
// ---------------------------------------------------------------------------

function buildModel(modelName: string) {
  return new ChatOpenAI({
    model: modelName,
    configuration: { baseURL: "https://openrouter.ai/api/v1" },
  });
}

export function createAgentV1(modelName: string) {
  return createAgent({
    model: buildModel(modelName),
    tools: [],
    systemPrompt: SYSTEM_PROMPT_V1,
  });
}

export function createAgentV2(modelName: string) {
  return createAgent({
    model: buildModel(modelName),
    tools: [],
    systemPrompt: SYSTEM_PROMPT_V2,
  });
}

export function createAgentV3(modelName: string) {
  return createAgent({
    model: buildModel(modelName),
    tools: [recipeSearchTool],
    systemPrompt: SYSTEM_PROMPT_V3,
  });
}

export function createAgentV4(modelName: string) {
  return createAgent({
    model: buildModel(modelName),
    tools: [recipeSearchTool],
    systemPrompt: SYSTEM_PROMPT_V4,
  });
}

export function createAgentV5(modelName: string) {
  return createAgent({
    model: buildModel(modelName),
    tools: [recipeSearchTool],
    systemPrompt: SYSTEM_PROMPT_V5,
  });
}
