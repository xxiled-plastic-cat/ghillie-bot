import type { PolyConfig } from "./polyConfig.js";
import { loadPolyScan } from "./polyMarketScanner.js";
import {
  expireStalePolyPaperOrders,
  placePolyPaperQuote,
  processPolyPaperFills,
} from "./polyPaperFillTracker.js";
import { updatePolyPaperUnrealised } from "./polyPaperPnlTracker.js";
import { checkPolyPaperRisk } from "./polyPaperRiskManager.js";
import { loadPolyPaperState, savePolyPaperState } from "./polyPaperStateStore.js";
import type {
  PolyPaperModel,
  PolyPaperModelState,
  PolyPaperState,
  PolyPaperTickResult,
  PolyPaperTickSummary,
} from "./polyPaperTypes.js";
import { scanPolyParity } from "./polyParityScanner.js";
import { buildParityQuotes, buildRewardQuotes, buildSpreadQuotes } from "./polyQuoteEngine.js";

function elapsedSeconds(state: PolyPaperModelState): number {
  if (!state.lastTickAt) return 0;
  return Math.max(0, (Date.now() - Date.parse(state.lastTickAt)) / 1000);
}

function runtimeHours(state: PolyPaperModelState, config: PolyConfig): number {
  const candidates = [
    state.lastTickAt,
    ...state.openOrders.map((order) => order.createdAt),
    ...state.fills.map((fill) => fill.createdAt),
  ].filter((value): value is string => Boolean(value));
  if (candidates.length === 0) {
    return (state.metrics.ticks * config.paperScanIntervalMs) / 3_600_000;
  }
  const first = Math.min(...candidates.map((value) => Date.parse(value)));
  if (!Number.isFinite(first)) {
    return (state.metrics.ticks * config.paperScanIntervalMs) / 3_600_000;
  }
  return Math.max(0, (Date.now() - first) / 3_600_000);
}

function topRejectReasons(
  reasons: Record<string, number>,
  limit = 3,
): Array<{ reason: string; count: number }> {
  return Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

function accumulateRewardDwell(state: PolyPaperModelState, seconds: number): void {
  if (seconds <= 0) return;
  const rewardOpen = state.openOrders.filter(
    (order) => order.status === "open" && order.lane === "reward",
  );
  if (rewardOpen.length === 0) return;
  state.metrics.rewardEligibleSeconds += seconds * rewardOpen.length;
}

function modelTick(
  model: PolyPaperModel,
  modelState: PolyPaperModelState,
  config: PolyConfig,
  quotes: ReturnType<typeof buildRewardQuotes>,
  scan: Awaited<ReturnType<typeof loadPolyScan>>,
): PolyPaperTickSummary {
  const beforeQuotesPlaced = modelState.metrics.quotesPlaced;
  const beforeFills = modelState.metrics.filledCount;
  const beforeExpired = Object.values(modelState.metrics.expiredByLane).reduce(
    (sum, value) => sum + value,
    0,
  );
  const parityGroups = new Set<string>();
  let rejectedQuotes = 0;
  const rejectReasonCounts: Record<string, number> = {};
  for (const quote of quotes) {
    const risk = checkPolyPaperRisk(quote, modelState, config);
    if (!risk.allowed) {
      rejectedQuotes += 1;
      rejectReasonCounts[risk.reason] = (rejectReasonCounts[risk.reason] ?? 0) + 1;
      continue;
    }
    if (quote.parityGroupId) {
      parityGroups.add(quote.parityGroupId);
      modelState.metrics.parityQuotedEdgeBpsSum += quote.parityEdgeBps ?? 0;
    }
    placePolyPaperQuote(modelState, quote);
  }
  modelState.metrics.parityAttempts += parityGroups.size;
  processPolyPaperFills(model, modelState, scan, config);
  if (modelState.metrics.filledCount > beforeFills) {
    const parityGroups = new Set(
      modelState.fills
        .slice(beforeFills)
        .filter((fill) => fill.lane === "parity" && fill.parityGroupId)
        .map((fill) => fill.parityGroupId as string),
    );
    modelState.metrics.parityFilled += parityGroups.size;
    modelState.metrics.parityFilledEdgeBpsSum += modelState.fills
      .slice(beforeFills)
      .filter((fill) => fill.lane === "parity")
      .reduce((sum, fill) => sum + (fill.parityEdgeBps ?? 0), 0);
  }
  expireStalePolyPaperOrders(modelState, config);
  const elapsed = elapsedSeconds(modelState);
  accumulateRewardDwell(modelState, elapsed);
  modelState.metrics.ticks += 1;
  modelState.lastTickAt = new Date().toISOString();
  const expiredTotal = Object.values(modelState.metrics.expiredByLane).reduce(
    (sum, value) => sum + value,
    0,
  );
  const openByLane = modelState.openOrders
    .filter((order) => order.status === "open")
    .reduce(
      (acc, order) => {
        acc[order.lane] += 1;
        return acc;
      },
      { reward: 0, spread: 0, parity: 0 },
    );
  return {
    model,
    candidateQuotes: quotes.length,
    rejectedQuotes,
    placedTick: modelState.metrics.quotesPlaced - beforeQuotesPlaced,
    filledTick: modelState.metrics.filledCount - beforeFills,
    expiredTick: expiredTotal - beforeExpired,
    placedTotal: modelState.metrics.quotesPlaced,
    fillsTotal: modelState.metrics.filledCount,
    openOrders: modelState.openOrders.length,
    openByLane,
    cash: modelState.cash,
    totalPnl: modelState.metrics.totalPnl,
    rewardEligibleHours: modelState.metrics.rewardEligibleSeconds / 3600,
    parityAttempts: modelState.metrics.parityAttempts,
    parityFilled: modelState.metrics.parityFilled,
    runtimeHours: runtimeHours(modelState, config),
    rejectReasonsTop: topRejectReasons(rejectReasonCounts),
  };
}

export async function runPolyPaperTick(config: PolyConfig): Promise<PolyPaperTickResult> {
  const [scan, state] = await Promise.all([
    loadPolyScan(config),
    loadPolyPaperState(config.paperStateKey, config.paperStartingBalanceUsd),
  ]);
  const parityPlans = scanPolyParity(scan.markets, scan.tokenBooksByConditionId, config);

  const conservativeQuotes = [
    ...buildRewardQuotes(scan, state.conservative, config),
    ...buildSpreadQuotes(scan, state.conservative, config),
    ...buildParityQuotes(scan, parityPlans, state.conservative, config),
  ];
  const balancedQuotes = [
    ...buildRewardQuotes(scan, state.balanced, config),
    ...buildSpreadQuotes(scan, state.balanced, config),
    ...buildParityQuotes(scan, parityPlans, state.balanced, config),
  ];

  const summaries = [
    modelTick("conservative", state.conservative, config, conservativeQuotes, scan),
    modelTick("balanced", state.balanced, config, balancedQuotes, scan),
  ];
  updatePolyPaperUnrealised(state.conservative, scan);
  updatePolyPaperUnrealised(state.balanced, scan);
  for (const summary of summaries) {
    const metrics =
      summary.model === "conservative" ? state.conservative.metrics : state.balanced.metrics;
    summary.totalPnl = metrics.totalPnl;
    summary.rewardEligibleHours = metrics.rewardEligibleSeconds / 3600;
  }

  await savePolyPaperState(config.paperStateKey, state);
  return { state, scanMarkets: scan.markets.length, summaries };
}

export async function loadPolyPaperReportState(config: PolyConfig): Promise<PolyPaperState> {
  return loadPolyPaperState(config.paperStateKey, config.paperStartingBalanceUsd);
}
