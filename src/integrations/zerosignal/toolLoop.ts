import type { InferenceCostCharge, InferenceCostSummary } from "./inferenceCost.js";
import { summarizeInferenceCosts } from "./inferenceCost.js";
import {
  buildReplayInput,
  createAgentResponse,
  extractFunctionCalls,
  type FunctionCallItem,
  type NormalizedAgentResponse,
  normalizeAgentResponse,
  type ResponsesClient,
  recordInferenceCharge,
} from "./responses.js";

export type ToolLoopFunctionOutput = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

export type RunResponsesToolLoopOptions = {
  openai: ResponsesClient;
  model: string;
  instructions: string;
  initialInput: string;
  tools: unknown[];
  reasoningEffort?: "low" | "medium" | "high";
  maxTurns: number;
  /** Execute model function calls; return Responses `function_call_output` items. */
  runTools: (calls: FunctionCallItem[]) => Promise<ToolLoopFunctionOutput[]>;
  toolChoice?: "auto" | "none" | "required";
};

export type RunResponsesToolLoopResult = {
  response: NormalizedAgentResponse;
  conversationItems: unknown[];
  inferenceCost?: InferenceCostSummary;
  turns: number;
};

/**
 * Canonical ZeroSignal multi-turn Responses loop:
 * every turn uses `store: false` and rebuilds `input` from the client transcript
 * (never `previous_response_id`).
 */
export async function runResponsesToolLoop(
  options: RunResponsesToolLoopOptions,
): Promise<RunResponsesToolLoopResult> {
  const inferenceCharges: InferenceCostCharge[] = [];
  let conversationItems: unknown[] = [];

  const first = await createAgentResponse(options.openai, {
    model: options.model,
    instructions: options.instructions,
    input: options.initialInput,
    store: false,
    tools: options.tools,
    tool_choice: options.toolChoice ?? "auto",
    ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
  });
  recordInferenceCharge(inferenceCharges, first.headers);
  let response = normalizeAgentResponse(first.data);

  for (let turn = 0; turn < options.maxTurns; turn += 1) {
    const functionCalls = extractFunctionCalls(response.output);
    if (functionCalls.length === 0) {
      return {
        response,
        conversationItems,
        inferenceCost: summarizeInferenceCosts(inferenceCharges),
        turns: turn + 1,
      };
    }

    const outputs = await options.runTools(functionCalls);
    conversationItems = [...conversationItems, ...response.output, ...outputs];

    const next = await createAgentResponse(options.openai, {
      model: options.model,
      instructions: options.instructions,
      input: buildReplayInput(options.initialInput, conversationItems),
      store: false,
      tools: options.tools,
      tool_choice: options.toolChoice ?? "auto",
      ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
    });
    recordInferenceCharge(inferenceCharges, next.headers);
    response = normalizeAgentResponse(next.data);
  }

  throw new Error(`ZeroSignal tool loop exceeded ${options.maxTurns} turns`);
}
