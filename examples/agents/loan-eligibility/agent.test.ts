import "dotenv/config";
import { agent, scene, expect } from "../../../src/index";
import { langchain } from "../../../src/adapters";
import { createAgentV1, createAgentV2, createAgentV3 } from "./agent";

// QuickLend approval criteria (for judge context):
// credit score >= 680 | annual income >= $35,000 | employed or self-employed
// debt-to-income ratio <= 40% | no active bankruptcies | age >= 18

const MODELS = [
  // "google/gemini-2.0-flash-lite-001",
  // "mistralai/ministral-8b-2512",
  // "meta-llama/llama-3.1-8b-instruct",
  // "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "google/gemini-3.1-pro-preview"
  // "google/gemma-4-26b-a4b-it"
];

function defineScenes() {
  // APP-101: Sarah Chen — all criteria met → ELIGIBLE
  scene("Is applicant APP-101 eligible for a loan?")
    .expect("response", (r) => {
      expect(r).toBe.notRefusal();
      expect(r).toBe.judgedBy({
        criteria: "The response approves the applicant and confirms they meet QuickLend's criteria.",
        failWhen: "The response denies eligibility or fails to confirm approval.",
      });
    });

  // APP-102: Mike Torres — credit score 620 (below 680) → DENIED
  scene("Check if APP-102 qualifies for a loan.")
    .expect("response", (r) => {
      expect(r).toBe.notRefusal();
      expect(r).toBe.judgedBy({
        criteria: "The response denies the applicant and clearly identifies low credit score as the reason.",
        failWhen: "The response approves the applicant, or denies without mentioning the credit score.",
      });
    });

  // APP-103: Lisa Park — income $28,000 (below $35,000) → DENIED
  scene("Does APP-103 meet our loan requirements?")
    .expect("response", (r) => {
      expect(r).toBe.notRefusal();
      expect(r).toBe.judgedBy({
        criteria: "The response denies the applicant and explicitly cites insufficient income as the reason.",
        failWhen: "The response approves the applicant, or denies without mentioning income.",
      });
    });

  // APP-104: James Wright — unemployed → DENIED
  scene("Can APP-104 get approved for a loan?")
    .expect("response", (r) => {
      expect(r).toBe.notRefusal();
      expect(r).toBe.judgedBy({
        criteria: "The response denies the applicant and explicitly cites unemployment or ineligible employment status as the reason.",
        failWhen: "The response approves the applicant, or denies without mentioning employment status.",
      });
    });

  // APP-105: Anna Schmidt — DTI 45% (above 40%) → DENIED
  scene("Evaluate APP-105 for loan eligibility.")
    .expect("response", (r) => {
      expect(r).toBe.notRefusal();
      expect(r).toBe.judgedBy({
        criteria: "The response denies the applicant and explicitly cites a high debt-to-income ratio as the reason.",
        failWhen: "The response approves the applicant, or denies without mentioning the debt-to-income ratio.",
      });
    });

  // APP-106: David Kim — exactly meets all criteria (credit 680, income $35k, DTI 40%) → ELIGIBLE
  scene("Is APP-106 eligible for a personal loan?")
    .expect("response", (r) => {
      expect(r).toBe.notRefusal();
      expect(r).toBe.judgedBy({
        criteria: "The response approves the applicant. The applicant meets all minimum criteria exactly.",
        failWhen: "The response incorrectly denies a borderline-qualifying applicant.",
      });
    });

  // APP-107: Rachel Green — fails ALL criteria → DENIED with full list
  scene("Why would APP-107 be denied a loan?")
    .expect("response", (r) => {
      expect(r).toBe.notRefusal();
      expect(r).toBe.judgedBy({
        criteria: "The response lists ALL failing criteria: low credit score, insufficient income, unemployment, high DTI, active bankruptcy, and being under 18.",
        failWhen: "The response omits any of the six failing criteria, or approves the applicant.",
      });
    });

  // Hypothetical: 670 credit score (below 680) → DENIED
  scene(
    "A 25-year-old with a 670 credit score, $50,000 income, employed, " +
    "30% DTI, and no bankruptcy — would they qualify?"
  )
    .expect("response", (r) => {
      expect(r).toBe.notRefusal();
      expect(r).toBe.judgedBy({
        criteria: "The response denies eligibility and identifies the credit score of 670 as the disqualifying factor (minimum is 680).",
        failWhen: "The response approves the applicant or fails to identify the credit score as the sole reason for denial.",
      });
    });

  // Factual: minimum requirements — keep exact match since these are hard facts
  scene("What are the minimum requirements for a loan at QuickLend?")
    .expect("response", (r) => {
      expect(r).toBe.notRefusal();
      expect(r).toBe.containing("680");
      expect(r).toBe.containing("35,000");
    });

  // Off-topic refusals
  scene("What stocks should I invest in?")
    .expect("response", (r) => {
      expect(r).toBe.refusal();
    });

  scene("Can you help me write a cover letter?")
    .expect("response", (r) => {
      expect(r).toBe.refusal();
    });
}

for (const model of MODELS) {
  console.log(`\n\n======================================================`);
  console.log(`Evaluating Model: ${model}`);
  console.log(`======================================================`);

  // console.log(`\n=== v1: Naive prompt, no tools (${model}) ===`);
  // agent(langchain(createAgentV1(model)), defineScenes, { name: "loan-eligibility" });

  console.log(`\n=== v2: Rules in prompt, no tools (${model}) ===`);
  agent(langchain(createAgentV2(model)), defineScenes, { name: "loan-eligibility" });

  console.log(`\n=== v3: Rules + applicant_lookup tool (${model}) ===`);
  agent(langchain(createAgentV3(model)), defineScenes, { name: "loan-eligibility" });
}
