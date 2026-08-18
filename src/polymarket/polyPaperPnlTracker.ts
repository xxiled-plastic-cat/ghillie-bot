import type { PolyConfig } from "./polyConfig.js";
import type { PolyPaperModelState, PolyPaperReport, PolyPaperState } from "./polyPaperTypes.js";
import type { PolyScanResult } from "./polyTypes.js";

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

export function updatePolyPaperUnrealised(state: PolyPaperModelState, scan: PolyScanResult): void {
  let unrealised = 0;
  for (const position of Object.values(state.positionsByTokenId)) {
    const book = scan.orderbooksByTokenId.get(position.tokenId);
    const mark = book?.midpoint ?? book?.bestBid ?? book?.bestAsk;
    position.lastMark = mark;
    if (mark === undefined) {
      position.unrealisedPnl = 0;
      continue;
    }
    const pnl = (mark - position.avgCost) * position.size;
    position.unrealisedPnl = pnl;
    unrealised += pnl;
  }
  state.metrics.unrealisedPnl = unrealised;
  state.metrics.totalPnl = state.metrics.realisedPnl + state.metrics.unrealisedPnl;
}

export function buildPolyPaperReport(
  model: "conservative" | "balanced",
  state: PolyPaperState,
  config: PolyConfig,
): PolyPaperReport {
  const modelState = model === "conservative" ? state.conservative : state.balanced;
  const fillRate =
    modelState.metrics.quotesPlaced > 0
      ? modelState.metrics.filledCount / modelState.metrics.quotesPlaced
      : 0;
  const cancelled = Object.values(modelState.metrics.expiredByLane).reduce(
    (sum, value) => sum + value,
    0,
  );
  const cancellationRatio =
    modelState.metrics.quotesPlaced > 0 ? cancelled / modelState.metrics.quotesPlaced : 0;
  const medianFillSeconds = percentile(modelState.metrics.fillSeconds, 0.5);
  const p95FillSeconds = percentile(modelState.metrics.fillSeconds, 0.95);
  const quoteCompetitivenessBps =
    modelState.metrics.quoteDistanceSamples > 0
      ? modelState.metrics.quoteDistanceBpsSum / modelState.metrics.quoteDistanceSamples
      : undefined;
  const parityConversionRate =
    modelState.metrics.parityAttempts > 0
      ? modelState.metrics.parityFilled / modelState.metrics.parityAttempts
      : 0;
  const quotedEdgeAvg =
    modelState.metrics.parityAttempts > 0
      ? modelState.metrics.parityQuotedEdgeBpsSum / modelState.metrics.parityAttempts
      : undefined;
  const filledEdgeAvg =
    modelState.metrics.parityFilled > 0
      ? modelState.metrics.parityFilledEdgeBpsSum / modelState.metrics.parityFilled
      : undefined;
  const parityEdgeDecayBps =
    quotedEdgeAvg !== undefined && filledEdgeAvg !== undefined
      ? quotedEdgeAvg - filledEdgeAvg
      : undefined;

  let verdict: PolyPaperReport["verdict"] = "viable";
  const medianForCheck = medianFillSeconds ?? Number.POSITIVE_INFINITY;
  if (
    fillRate < config.paperViableMinFillRate ||
    medianForCheck > config.paperViableMaxMedianFillSeconds ||
    modelState.metrics.totalPnl < config.paperViableMinPnlUsd
  ) {
    verdict = "borderline";
  }
  if (
    fillRate < config.paperViableMinFillRate * 0.5 ||
    medianForCheck > config.paperViableMaxMedianFillSeconds * 1.5 ||
    modelState.metrics.totalPnl < config.paperViableMinPnlUsd * 2
  ) {
    verdict = "not_viable";
  }

  return {
    model,
    fillRate,
    medianFillSeconds,
    p95FillSeconds,
    cancellationRatio,
    quoteCompetitivenessBps,
    realisedPnl: modelState.metrics.realisedPnl,
    unrealisedPnl: modelState.metrics.unrealisedPnl,
    totalPnl: modelState.metrics.totalPnl,
    rewardEligibleHours: modelState.metrics.rewardEligibleSeconds / 3600,
    parityConversionRate,
    parityEdgeDecayBps,
    verdict,
  };
}
