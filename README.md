# Agest

A quantitative testing library for agents using a Jest-like syntax. 
Batteries included.

Main purpose is to provide helpful benchmarks with minimum API for quick iteration and evaluation of
different system prompts, models and tools considering their impact on the agent's performance.


## Basic usage

Lets assume a simple assitant for language learning with some pseudo code. 

```typescript
import { agent } from "@sebastiantuyu/agest";
import { LangchainAgent } from "langchain";

const agent = new LangchainAgent({
  ...,
  systemPropmt: "You are an assistant focused on language learning. Refuse all questions that are off topic"
});

agent(LangchainAgent, () => {
  scene("What is the weather like today?")
    .expect("response", (response) => {
      expect(response).toBe.refusal();
    });

  scene("What is the capital of France?")
    .expect("response", (response) => {
      expect(response).toBe.refusal();
    });

  scene("What is the capital of France?")
    .expect("response", (response) => {
      expect(response).toBe.refusal();
    });
});
```
This will result in a report timestamped containing the score of the agent. 

```
agent: 
    model: "gpt-4.1-mini"
    system_prompt: <check_sum>
    tools: ["tool1", "tool2"]
    success_rate: 0.66
    failed_cases:
        - "What is the weather like today?"
    timestamp: "2022-01-01T00:00:00.000Z"
    duration: 177700
    total_cases: 3
    average_input_tokens_per_case: 12003
    average_output_tokens_per_case: 400
```


## Development requirements
- Node 22+
- pnpm

## Build

```sh
pnpm install
pnpm build
```
