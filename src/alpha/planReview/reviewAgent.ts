import type { AlphaConfig } from "../alphaConfig.js";
import type { AlphaBotState, AlphaMarket, AlphaOrderbook, AlphaQuote } from "../alphaTypes.js";
import {
  assertZsProxyHealthy,
  buildReplayInput,
  createAgentResponse,
  createZeroSignalClient,
  extractOutputText,
  formatInferenceCostLine,
  normalizeAgentResponse,
  recordInferenceCharge,
  summarizeInferenceCosts,
  type InferenceCostCharge,
  type ResponsesClient,
  type ZeroSignalReasoningEffort,
} from "../../integrations/zerosignal/index.js";
import { loadOperatorPreferencesFromEnv } from "../../integrations/storage/operatorPreferences.js";
import { applyPlanReviewDecisions, type PlanReviewSkipAction } from "./apply.js";
import { buildPlanReviewPayload, isEntryQuote } from "./payload.js";
import {
  PLAN_REVIEW_JSON_REPAIR_MESSAGE,
  buildPlanReviewInstructions,
} from "./prompt.js";
import { parsePlanReviewResponse, type PlanReviewResponse } from "./schema.js";

export type PlanReviewAgentResult = {
  placementQueue: AlphaQuote[];
  actions: PlanReviewSkipAction[];
  reviewed: boolean;
  inferenceCostLine?: string;
};

export type RunPlanReviewOptions = {
  placementQueue: AlphaQuote[];
  state: AlphaBotState;
  orderbooks: Map<number, AlphaOrderbook>;
  markets: Map<number, AlphaMarket>;
  config: AlphaConfig;
  walletUsdc?: number;
  /** Injected for tests. */
  responsesClient?: ResponsesClient;
  model?: string;
  reasoningEffort?: ZeroSignalReasoningEffort;
  /** Injected for tests — skip real health check when client is mocked. */
  skipHealthCheck?: boolean;
  /**
   * Optional operator strategy markdown. When undefined, loads from Spaces
   * (`{DO_SPACES_PREFIX}/operator-preferences.md`) or local `config/operator-preferences.md`.
   * Pass `""` or inject `loadOperatorPreferences` in tests to skip I/O.
   */
  operatorPreferences?: string;
  /** Injected for tests — replaces Spaces/local load. */
  loadOperatorPreferences?: () => Promise<string | undefined>;
};

async function callPlanReviewModel(input: {
  responses: ResponsesClient;
  model: string;
  reasoningEffort: ZeroSignalReasoningEffort;
  payloadJson: string;
  instructions: string;
  charges: InferenceCostCharge[];
}): Promise<string> {
  const first = await createAgentResponse(input.responses, {
    model: input.model,
    store: false,
    instructions: input.instructions,
    input: input.payloadJson,
    reasoning: { effort: input.reasoningEffort },
  });
  recordInferenceCharge(input.charges, first.headers);
  const firstNormalized = normalizeAgentResponse(first.data);
  const firstText = firstNormalized.output_text ?? extractOutputText(firstNormalized.output);
  if (firstText) {
    try {
      parsePlanReviewResponse(firstText);
      return firstText;
    } catch {
      // one repair turn
    }
  }

  const repairInput = buildReplayInput(
    input.payloadJson,
    firstNormalized.output,
    PLAN_REVIEW_JSON_REPAIR_MESSAGE,
  );
  const repair = await createAgentResponse(input.responses, {
    model: input.model,
    store: false,
    instructions: input.instructions,
    input: repairInput,
    reasoning: { effort: input.reasoningEffort },
  });
  recordInferenceCharge(input.charges, repair.headers);
  const repairNormalized = normalizeAgentResponse(repair.data);
  const repairText = repairNormalized.output_text ?? extractOutputText(repairNormalized.output);
  if (!repairText) {
    throw new Error("Plan review model returned empty text after repair");
  }
  return repairText;
}

/**
 * Always review reward/spread entry quotes in the placement queue via ZeroSignal.
 * Inventory exits pass through. Fail closed: drop entries on any review failure.
 */
export async function runPlanReview(options: RunPlanReviewOptions): Promise<PlanReviewAgentResult> {
  const entryQuotes = options.placementQueue.filter(isEntryQuote);
  // Always review entry bids/asks via ZeroSignal. Inventory exits pass through.
  if (entryQuotes.length === 0) {
    return {
      placementQueue: options.placementQueue,
      actions: [],
      reviewed: false,
    };
  }

  const actions: PlanReviewSkipAction[] = [
    {
      kind: "skip",
      message: `Plan review: sending ${entryQuotes.length} entry quote(s) to ZeroSignal`,
    },
  ];

  const payload = buildPlanReviewPayload({
    entryQuotes,
    state: options.state,
    orderbooks: options.orderbooks,
    markets: options.markets,
    walletUsdc: options.walletUsdc,
    inventoryCeilingUsd: options.config.maxInventoryNotionalUsd,
    maxSingleOrderUsd: Math.max(
      options.config.rewardMaxOrderSizeUsd,
      options.config.spreadMaxOrderSizeUsd,
    ),
  });
  const payloadJson = JSON.stringify(payload);
  const charges: InferenceCostCharge[] = [];

  let response: PlanReviewResponse | undefined;
  let failReason: string | undefined;

  try {
    const zs = createZeroSignalClient();
    const responses = options.responsesClient ?? zs.responses;
    const model = options.model ?? zs.config.openaiModel;
    const reasoningEffort =
      options.reasoningEffort ??
      options.config.planReviewReasoningEffort ??
      zs.config.openaiReasoningEffort;

    if (!options.skipHealthCheck && !options.responsesClient) {
      await assertZsProxyHealthy(zs.config.openaiBaseUrl);
    }

    const operatorPreferences =
      options.operatorPreferences !== undefined
        ? options.operatorPreferences
        : options.loadOperatorPreferences
          ? await options.loadOperatorPreferences()
          : await loadOperatorPreferencesFromEnv();
    const instructions = buildPlanReviewInstructions(operatorPreferences);

    const text = await callPlanReviewModel({
      responses,
      model,
      reasoningEffort,
      payloadJson,
      instructions,
      charges,
    });
    response = parsePlanReviewResponse(text);
  } catch (error) {
    failReason = error instanceof Error ? error.message : String(error);
    console.error(`[ghillie-plan-review] failed closed: ${failReason}`);
  }

  const applied = applyPlanReviewDecisions({
    placementQueue: options.placementQueue,
    entryQuotes,
    response,
    failReason,
  });
  actions.push(...applied.actions);

  const inferenceCostLine = formatInferenceCostLine(summarizeInferenceCosts(charges));
  if (inferenceCostLine) {
    actions.push({ kind: "skip", message: inferenceCostLine });
  }

  return {
    placementQueue: applied.placementQueue,
    actions,
    reviewed: true,
    inferenceCostLine,
  };
}
