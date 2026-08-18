import type { ExecutionConfig, TopTarget } from "../types/execution.js";
import type { LiquiditySignal } from "../types/market.js";

function toCents(price: number | undefined, fallback: number, config: ExecutionConfig): number {
  if (price === undefined || Number.isNaN(price)) return fallback;
  return Math.round(Math.min(config.maxPriceCents, Math.max(config.minPriceCents, price * 100)));
}

function parseMarketId(signal: LiquiditySignal): number | undefined {
  const raw = signal.marketGroupId ?? signal.marketId.split(":")[0];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function getExecutionPenalty(signal: LiquiditySignal, config: ExecutionConfig): number {
  let penalty = 0;
  if (signal.haltBufferMinutes < config.haltBlockMinutes + 5) penalty += 0.2;
  if (signal.bookState === "empty") penalty += 0.04;
  if (signal.kind === "seed_liquidity" && signal.rewardAllocation <= 0) penalty += 0.18;
  if (signal.suggestedYesBid !== undefined && signal.suggestedYesBid < 0.1) penalty += 0.05;
  if (signal.suggestedNoBid !== undefined && signal.suggestedNoBid < 0.1) penalty += 0.05;
  return penalty;
}

function buildReason(signal: LiquiditySignal, targetScore: number): string {
  return [
    `${signal.kind} signal scored ${(signal.score * 100).toFixed(1)}`,
    `execution-adjusted ${(targetScore * 100).toFixed(1)}`,
    `book=${signal.bookState}`,
    `reward=${signal.rewardAllocation.toFixed(2)}`,
    `halt=${signal.haltBufferMinutes.toFixed(1)}m`,
    signal.reason,
  ].join("; ");
}

export function selectTopTarget(
  signals: LiquiditySignal[],
  config: ExecutionConfig,
): TopTarget | undefined {
  const targets = signals
    .map((signal): TopTarget | undefined => {
      const marketId = parseMarketId(signal);
      if (marketId === undefined || signal.strikeIndex === undefined || signal.haltTs === undefined)
        return undefined;
      if (signal.haltBufferMinutes <= config.haltBlockMinutes) return undefined;

      const yesBuyPriceCents = toCents(signal.suggestedYesBid, config.minPriceCents, config);
      const noBuyPriceCents = toCents(signal.suggestedNoBid, config.minPriceCents, config);
      const activeOrdersNeeded = 2;
      const usdcaAtRiskCents =
        yesBuyPriceCents * config.orderQuantity + (100 - noBuyPriceCents) * config.orderQuantity;
      if (activeOrdersNeeded > config.maxActiveOrders) return undefined;
      if (usdcaAtRiskCents > config.maxUsdcaAtRiskCents) return undefined;
      if (yesBuyPriceCents + noBuyPriceCents >= 100) return undefined;

      const targetScore = Math.max(0, signal.score - getExecutionPenalty(signal, config));
      return {
        marketId,
        strikeIndex: signal.strikeIndex,
        strikeCents: Math.round(signal.strike * 100),
        underlying: signal.underlying,
        timeframe: signal.timeframe,
        expiryTs: signal.expiryTs,
        haltTs: signal.haltTs,
        sourceSignal: signal,
        targetScore,
        yesBuyPriceCents,
        noBuyPriceCents,
        quantity: config.orderQuantity,
        reason: buildReason(signal, targetScore),
      };
    })
    .filter((target): target is TopTarget => target !== undefined);

  return targets.sort((a, b) => b.targetScore - a.targetScore)[0];
}

export function targetKey(target: Pick<TopTarget, "marketId" | "strikeIndex">): string {
  return `${target.marketId}:${target.strikeIndex}`;
}
