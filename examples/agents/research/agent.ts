import "dotenv/config";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { createAgent } from "langchain";

const SEARCH_INDEX: Record<string, string> = {
  "eiffel tower":
    "The Eiffel Tower was completed in 1889. It stands 330 meters (1,083 ft) tall and is located in Paris, France. Designed by Gustave Eiffel.",
  "python language":
    "Python was created by Guido van Rossum. The first public release (Python 0.9.0) was in February 1991. Version 3.0 was released in December 2008.",
  "speed of light":
    "The speed of light in a vacuum is exactly 299,792,458 metres per second (approximately 3×10⁸ m/s). This is a universal physical constant.",
  "mount everest":
    "Mount Everest is the world's highest mountain, with a peak at 8,848.86 metres (29,031.7 ft) above sea level. Located in the Himalayas on the Nepal–Tibet border.",
  "turing test":
    "The Turing Test was proposed by Alan Turing in his 1950 paper 'Computing Machinery and Intelligence'. It evaluates a machine's ability to exhibit intelligent behaviour indistinguishable from a human.",
};

function mockSearch(query: string): string {
  const key = Object.keys(SEARCH_INDEX).find((k) =>
    query.toLowerCase().includes(k)
  );
  if (key) return SEARCH_INDEX[key];
  return "No results found for that query.";
}

const model = new ChatOpenAI({
  model: "openai/gpt-oss-20b",
  configuration: {
    baseURL: "https://openrouter.ai/api/v1",
  },
});

const webSearchTool = tool(
  async ({ query }) => mockSearch(query),
  {
    name: "web_search",
    description:
      "Search the web for factual information. Always call this before stating any fact. Returns the most relevant result or 'No results found' if nothing matches.",
    schema: z.object({
      query: z.string().describe("The search query"),
    }),
  }
);

const SYSTEM_PROMPT =
  "You are a research assistant. You must use the web_search tool to verify " +
  "every factual claim before answering. If the search returns no results, " +
  "explicitly say you could not find reliable information and do not guess. " +
  "Keep answers concise and include the specific facts from the search result.";

export const researchAgent = createAgent({
  model,
  tools: [webSearchTool],
  systemPrompt: SYSTEM_PROMPT,
});
