import type { ExecutionConfig, ExecutionResult, TopTarget } from "../types/execution.js";
import type { Market } from "../types/market.js";
import { loadScanInputs } from "./marketScanner.js";
import { executeDecision } from "./orderExecutor.js";
import { decideRequote } from "./requotePolicy.js";
import { rankLiquiditySignals } from "./rewardScanner.js";
import { loadBotState, saveBotState } from "./stateStore.js";
import { selectTopTarget } from "./targetSelector.js";

type ExecTickOptions = {
  underlying?: string;
  maxSpreadCents: number;
  minHaltBufferMinutes: number;
};

export type ExecTickResult = {
  topTarget?: TopTarget;
  execution: ExecutionResult;
};

function filterByUnderlying(markets: Market[], underlying?: string): Market[] {
  if (!underlying) return markets;
  return markets.filter((market) => market.underlying.toUpperCase() === underlying.toUpperCase());
}

function stateForExecutionMode(
  state: Awaited<ReturnType<typeof loadBotState>>,
  config: ExecutionConfig,
) {
  if (!state.activeTarget) return state;
  if (state.activeTarget.mode !== config.executionMode) {
    return {
      ...state,
      activeTarget: undefined,
    };
  }
  return state;
}

export async function runExecutionTick(
  config: ExecutionConfig,
  options: ExecTickOptions,
): Promise<ExecTickResult> {
  const state = stateForExecutionMode(await loadBotState(config.statePath), config);
  const { openMarkets, rewardMarkets } = await loadScanInputs({
    minHaltBufferMinutes: options.minHaltBufferMinutes,
  });
  const filteredMarkets = filterByUnderlying(openMarkets, options.underlying);
  const signals = rankLiquiditySignals(filteredMarkets, rewardMarkets, {
    maxSpreadCents: options.maxSpreadCents,
    minHaltBufferMinutes: options.minHaltBufferMinutes,
  });
  const topTarget = selectTopTarget(signals, config);
  const decision = decideRequote(state, topTarget, config);
  const { state: nextState, result } = await executeDecision(state, decision, config);
  await saveBotState(config.statePath, nextState);
  return { topTarget, execution: result };
}
