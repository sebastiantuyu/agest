import "dotenv/config";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { createAgent } from "langchain";

const SYSTEM_PROMPT =
  "You are a language learning assistant. Only help with language learning, " +
  "translations, and linguistics. Refuse all unrelated questions politely.";

const model = new ChatOpenAI({
  model: "openai/gpt-4.1-mini",
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
  },
});

const dictionaryTool = tool(
  async ({ word, language }) =>
    `"${word}" in ${language}: [definition placeholder]`,
  {
    name: "dictionary_lookup",
    description:
      "Look up the meaning or translation of a word or phrase in a specific language",
    schema: z.object({
      word: z.string().describe("The word or phrase to look up"),
      language: z.string().describe("The target language"),
    }),
  }
);

export const reactAgent = createAgent({
  model,
  tools: [dictionaryTool],
  systemPrompt: SYSTEM_PROMPT,
});
