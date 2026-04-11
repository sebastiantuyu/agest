import type { AgentExecutor, AgentResponse } from "../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Runnable = { invoke: (input: any) => Promise<any> };

type LangGraphGraph = Runnable & {
  lg_is_pregel: true;
  nodes?: Record<string, any>;
};

type LangChainReactAgent = Runnable & {
  options: {
    model?: string | any;
    tools?: any[];
    systemPrompt?: string;
    prompt?: string;
  };
};

type SimpleChain = Runnable & {
  steps?: any[];
};

/**
 * Adapter for LangChain runnables and agents.
 *
 * Supported inputs:
 * - `createAgent(...)` from `langchain` — meta extracted from `agent.options`
 * - `createReactAgent(...)` from `@langchain/langgraph/prebuilt` — tools from
 *   `graph.nodes.tools`, model from response_metadata
 * - Simple chain (`prompt.pipe(model)`) — meta extracted from `steps[]`
 */
export function langchain(
  runnable: LangGraphGraph | LangChainReactAgent | SimpleChain
): AgentExecutor {
  if (isLangGraphGraph(runnable)) {
    return langGraphAdapter(runnable);
  }
  if (isReactAgent(runnable)) {
    return reactAgentAdapter(runnable);
  }
  return chainAdapter(runnable as SimpleChain);
}


function langGraphAdapter(graph: LangGraphGraph): AgentExecutor {
  const staticTools = extractGraphTools(graph);

  return async (input: string): Promise<AgentResponse> => {
    let result: Record<string, any>;
    try {
      const { HumanMessage } = await import("@langchain/core/messages");
      result = await graph.invoke({ messages: [new HumanMessage(input)] });
    } catch (err) {
      return { text: "", executionError: (err as Error).message, metadata: { tools: staticTools } };
    }

    const messages = result.messages as any[];
    const last = messages[messages.length - 1];
    const text =
      typeof last?.content === "string"
        ? last.content
        : JSON.stringify(last?.content ?? result);
    const model = last?.response_metadata?.model_name as string | undefined;

    return {
      text,
      metadata: { model, tools: staticTools, tokens: extractTokensFromMessage(last) },
    };
  };
}

function reactAgentAdapter(agent: LangChainReactAgent): AgentExecutor {
  const model =
    typeof agent.options.model === "string"
      ? agent.options.model
      : (agent.options.model as any)?.modelName ?? (agent.options.model as any)?.model;
  const systemPrompt =
    agent.options.systemPrompt ?? agent.options.prompt ?? undefined;
  const tools = agent.options.tools
    ?.map((t: any) => t.name ?? t.getName?.())
    .filter(Boolean) as string[] | undefined;

  return async (input: string): Promise<AgentResponse> => {
    let result: Record<string, any>;
    try {
      result = await agent.invoke({ messages: [{ role: "human", content: input }] });
    } catch (err) {
      return { text: "", executionError: (err as Error).message, metadata: { model, systemPrompt, tools } };
    }

    const messages = result.messages as any[];
    const last = messages[messages.length - 1];
    const text =
      typeof last?.content === "string"
        ? last.content
        : JSON.stringify(last?.content ?? result);

    return {
      text,
      metadata: { model, systemPrompt, tools, tokens: extractTokensFromMessage(last) },
    };
  };
}

function chainAdapter(chain: SimpleChain): AgentExecutor {
  const { model, systemPrompt } = extractChainMeta(chain);

  return async (input: string): Promise<AgentResponse> => {
    let result: Record<string, any>;
    try {
      result = await chain.invoke({ input });
    } catch (err) {
      return { text: "", executionError: (err as Error).message, metadata: { model, systemPrompt } };
    }

    const text =
      typeof result === "string"
        ? result
        : typeof result.output === "string"
          ? result.output
          : typeof result.content === "string"
            ? result.content
            : JSON.stringify(result);

    return {
      text,
      metadata: {
        model: model ?? (result.metadata?.model as string | undefined),
        systemPrompt,
        tokens: extractTokens(result),
      },
    };
  };
}


function isLangGraphGraph(r: any): r is LangGraphGraph {
  return r.lg_is_pregel === true;
}

function isReactAgent(r: any): r is LangChainReactAgent {
  return r.options !== undefined && typeof r.options === "object" && !Array.isArray(r.options);
}


function extractGraphTools(graph: LangGraphGraph): string[] | undefined {
  const tools: any[] = graph.nodes?.["tools"]?.bound?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((t: any) => t.name ?? t.getName?.()).filter(Boolean) as string[];
}

function extractChainMeta(chain: any): { model?: string; systemPrompt?: string } {
  function fromSteps(steps: any[]): { model?: string; systemPrompt?: string } {
    let model: string | undefined;
    let systemPrompt: string | undefined;

    for (const step of steps ?? []) {
      if (!model && (step.modelName || step.model)) {
        model = step.modelName ?? step.model;
      }
      if (!systemPrompt && Array.isArray(step.promptMessages)) {
        for (const msg of step.promptMessages) {
          const name = msg?.constructor?.name ?? "";
          if (name.toLowerCase().includes("system")) {
            systemPrompt = msg?.prompt?.template ?? msg?.template;
            break;
          }
        }
      }
      if (step.steps) {
        const nested = fromSteps(step.steps);
        model ??= nested.model;
        systemPrompt ??= nested.systemPrompt;
      }
    }

    return { model, systemPrompt };
  }

  return fromSteps(chain.steps ?? []);
}

function extractTokens(
  result: Record<string, any>
): { input: number; output: number } | undefined {
  const usage =
    result.usage_metadata ??
    result.metadata?.tokenUsage ??
    result.metadata?.usage ??
    result.llmOutput?.tokenUsage;

  if (!usage) return undefined;

  return {
    input: usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens ?? 0,
    output:
      usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens ?? 0,
  };
}

function extractTokensFromMessage(
  msg: any
): { input: number; output: number } | undefined {
  const usage = msg?.usage_metadata ?? msg?.response_metadata?.usage;
  if (!usage) return undefined;
  return {
    input: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    output: usage.output_tokens ?? usage.completion_tokens ?? 0,
  };
}
