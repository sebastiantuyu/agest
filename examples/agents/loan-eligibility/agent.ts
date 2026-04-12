import "dotenv/config";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { createAgent } from "langchain";

const APPLICANTS: Record<
  string,
  {
    name: string;
    creditScore: number;
    annualIncome: number;
    employment: "employed" | "self-employed" | "unemployed";
    debtToIncomeRatio: number;
    activeBankruptcy: boolean;
    age: number;
  }
> = {
  "APP-101": {
    name: "Sarah Chen",
    creditScore: 750,
    annualIncome: 85000,
    employment: "employed",
    debtToIncomeRatio: 25,
    activeBankruptcy: false,
    age: 34,
  },
  "APP-102": {
    name: "Mike Torres",
    creditScore: 620,
    annualIncome: 42000,
    employment: "employed",
    debtToIncomeRatio: 35,
    activeBankruptcy: false,
    age: 28,
  },
  "APP-103": {
    name: "Lisa Park",
    creditScore: 710,
    annualIncome: 28000,
    employment: "employed",
    debtToIncomeRatio: 30,
    activeBankruptcy: false,
    age: 22,
  },
  "APP-104": {
    name: "James Wright",
    creditScore: 695,
    annualIncome: 55000,
    employment: "unemployed",
    debtToIncomeRatio: 15,
    activeBankruptcy: false,
    age: 45,
  },
  "APP-105": {
    name: "Anna Schmidt",
    creditScore: 720,
    annualIncome: 62000,
    employment: "self-employed",
    debtToIncomeRatio: 45,
    activeBankruptcy: false,
    age: 38,
  },
  "APP-106": {
    name: "David Kim",
    creditScore: 680,
    annualIncome: 35000,
    employment: "employed",
    debtToIncomeRatio: 40,
    activeBankruptcy: false,
    age: 18,
  },
  "APP-107": {
    name: "Rachel Green",
    creditScore: 590,
    annualIncome: 25000,
    employment: "unemployed",
    debtToIncomeRatio: 55,
    activeBankruptcy: true,
    age: 17,
  },
};

const applicantLookupTool = tool(
  async ({ applicantId }) => {
    const app = APPLICANTS[applicantId.toUpperCase()];
    if (!app) return `Applicant ${applicantId} not found in our system.`;
    return (
      `${app.name} (${applicantId}): ` +
      `Credit Score: ${app.creditScore} | ` +
      `Annual Income: $${app.annualIncome.toLocaleString()} | ` +
      `Employment: ${app.employment} | ` +
      `Debt-to-Income Ratio: ${app.debtToIncomeRatio}% | ` +
      `Active Bankruptcy: ${app.activeBankruptcy} | ` +
      `Age: ${app.age}`
    );
  },
  {
    name: "applicant_lookup",
    description:
      "Retrieve an applicant's financial profile by their ID (e.g. APP-101).",
    schema: z.object({
      applicantId: z
        .string()
        .describe("The applicant ID to look up (e.g. APP-101)"),
    }),
  }
);

const SYSTEM_PROMPT_V1 =
  "You are a loan officer. Help people determine if they qualify for a personal loan.";

const SYSTEM_PROMPT_V2 =
  "You are a loan officer at QuickLend. You evaluate personal loan applications.\n\n" +
  "ALL of the following criteria must be met for approval:\n" +
  "- Credit score >= 680\n" +
  "- Annual income >= $35,000\n" +
  "- Employment status must be 'employed' or 'self-employed'\n" +
  "- Debt-to-income ratio <= 40%\n" +
  "- No active bankruptcies\n" +
  "- Applicant must be at least 18 years old\n\n" +
  "If any criterion is not met, deny the application and list EVERY failing criterion.\n" +
  "Politely decline any request unrelated to loan eligibility.";

const SYSTEM_PROMPT_V3 =
  "You are a loan officer at QuickLend. You evaluate personal loan applications.\n\n" +
  "ALL of the following criteria must be met for approval:\n" +
  "- Credit score >= 680\n" +
  "- Annual income >= $35,000\n" +
  "- Employment status must be 'employed' or 'self-employed'\n" +
  "- Debt-to-income ratio <= 40%\n" +
  "- No active bankruptcies\n" +
  "- Applicant must be at least 18 years old\n\n" +
  "IMPORTANT: Before evaluating any applicant, you MUST call the applicant_lookup " +
  "tool to retrieve their financial profile. Never guess or assume applicant data.\n\n" +
  "If any criterion is not met, deny the application and list EVERY failing criterion.\n" +
  "Politely decline any request unrelated to loan eligibility.";

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
    tools: [applicantLookupTool],
    systemPrompt: SYSTEM_PROMPT_V3,
  });
}
