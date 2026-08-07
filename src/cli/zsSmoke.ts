/**
 * LLM smoke: ZeroSignal (zs-proxy) + one paid Amarok research tool.
 * Never requests execution quotes, never signs, never places orders.
 */
import dotenv from "dotenv";

import { createAmarokCliRuntime, printCliError } from "./amarokShared.js";
import {
  assertZsProxyHealthy,
  createZeroSignalClient,
  extractOutputText,
  formatInferenceCostLine,
  runResponsesToolLoop,
  selectAgentResearchTools,
  toOpenAiFunctionTool,
} from "../integrations/zerosignal/index.js";

dotenv.config();

const SMOKE_TOOL = "amarok_list_opportunities";
const MAX_TURNS = 4;

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  } catch {
    return {};
  }
}

function countOpportunities(data: unknown): number {
  if (!data || typeof data !== "object") return 0;
  const record = data as { data?: unknown; opportunities?: unknown };
  if (Array.isArray(record.data)) return record.data.length;
  if (Array.isArray(record.opportunities)) return record.opportunities.length;
  return 0;
}

export async function runZsSmoke(): Promise<{
  model: string;
  baseURL: string;
  toolCalled: string;
  opportunityCount: number;
  assistantText?: string;
  x402BaseUnits?: string;
  inferenceCostLine?: string;
}> {
  const { runtime, walletAddress } = createAmarokCliRuntime();
  const zs = createZeroSignalClient();

  await assertZsProxyHealthy(zs.config.openaiBaseUrl);

  try {
    const tools = selectAgentResearchTools(await runtime.client.listTools())
      .filter((tool) => tool.name === SMOKE_TOOL)
      .map(toOpenAiFunctionTool);
    if (tools.length !== 1) {
      throw new Error(`Smoke tool ${SMOKE_TOOL} not available from Amarok MCP`);
    }

    const initialInput =
      "Call amarok_list_opportunities exactly once with limit=3. " +
      "After the tool result, reply with one short sentence confirming how many opportunities were returned. " +
      "Do not call any other tools.";

    let toolCalled: string | undefined;
    let opportunityCount = 0;
    let x402BaseUnits: string | undefined;

    const loop = await runResponsesToolLoop({
      openai: zs.responses,
      model: zs.config.openaiModel,
      instructions:
        "You are a connectivity smoke test. Use only the provided tool, then answer briefly.",
      initialInput,
      tools,
      reasoningEffort: zs.config.openaiReasoningEffort,
      maxTurns: MAX_TURNS,
      async runTools(calls) {
        const outputs = [];
        for (const call of calls) {
          if (call.name !== SMOKE_TOOL) {
            outputs.push({
              type: "function_call_output" as const,
              call_id: call.call_id,
              output: JSON.stringify({
                error: "TOOL_NOT_ALLOWED",
                message: `Smoke test only allows ${SMOKE_TOOL}`,
              }),
            });
            continue;
          }
          const args = parseArgs(call.arguments);
          const result = await runtime.client.callManagedTool(
            SMOKE_TOOL,
            {
              ...args,
              limit: 3,
            },
            walletAddress,
          );
          toolCalled = SMOKE_TOOL;
          if (result.payment) {
            x402BaseUnits = result.payment.amountBaseUnits;
          }
          opportunityCount = countOpportunities(result.data);
          outputs.push({
            type: "function_call_output" as const,
            call_id: call.call_id,
            output: JSON.stringify({
              ok: true,
              count: opportunityCount,
            }),
          });
        }
        return outputs;
      },
    });

    if (!toolCalled) {
      throw new Error("LLM finished without calling amarok_list_opportunities");
    }

    return {
      model: zs.config.openaiModel,
      baseURL: zs.config.openaiBaseUrl,
      toolCalled,
      opportunityCount,
      assistantText:
        loop.response.output_text ?? extractOutputText(loop.response.output),
      x402BaseUnits,
      inferenceCostLine: formatInferenceCostLine(loop.inferenceCost),
    };
  } finally {
    await runtime.close();
  }
}

const isDirectRun = process.argv[1]?.match(/zsSmoke\.(ts|js)$/) != null;
if (isDirectRun) {
  try {
    const result = await runZsSmoke();
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "ok",
          ...result,
          note: "No execution quotes, no signing, no order placement",
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    printCliError(error);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  }
}
