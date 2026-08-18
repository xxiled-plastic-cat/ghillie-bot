import type { PolyConfig } from "./polyConfig.js";
import type { PolyBookLevel, PolyMarket, PolyParityPlan, PolyTokenBookPair } from "./polyTypes.js";

function totalSize(levels: PolyBookLevel[]): number {
  return levels.reduce((sum, level) => sum + level.size, 0);
}

function weightedPrice(levels: PolyBookLevel[], size: number): number | undefined {
  if (size <= 0) return undefined;
  let remaining = size;
  let notional = 0;
  for (const level of levels) {
    const take = Math.min(remaining, level.size);
    notional += take * level.price;
    remaining -= take;
    if (remaining <= 0.000001) break;
  }
  if (remaining > 0.000001) return undefined;
  return notional / size;
}

function bestParitySize(
  yesLevels: PolyBookLevel[],
  noLevels: PolyBookLevel[],
  config: PolyConfig,
  edgeFn: (yes: number, no: number) => number,
  notionalFn: (size: number, yes: number, no: number) => number,
): { size: number; yes: number; no: number; edgeBps: number; netEdgeBps: number } | undefined {
  const maxSize = Math.min(totalSize(yesLevels), totalSize(noLevels));
  if (maxSize <= 0) return undefined;
  const slippageBufferBps = (config.paritySlippageCents / 100) * 2 * 10_000;
  let low = 0.000001;
  let high = maxSize;
  let best:
    | { size: number; yes: number; no: number; edgeBps: number; netEdgeBps: number }
    | undefined;
  for (let i = 0; i < 24; i += 1) {
    const size = (low + high) / 2;
    const yes = weightedPrice(yesLevels, size);
    const no = weightedPrice(noLevels, size);
    if (yes === undefined || no === undefined) {
      high = size;
      continue;
    }
    const notional = notionalFn(size, yes, no);
    if (notional > config.parityMaxTradeUsd) {
      high = size;
      continue;
    }
    const edgeBps = edgeFn(yes, no);
    const netEdgeBps = edgeBps - slippageBufferBps;
    if (
      notional >= config.parityMinTradeUsd &&
      notional >= config.parityMinDepthUsd &&
      netEdgeBps >= config.parityMinEdgeBps
    ) {
      best = { size, yes, no, edgeBps, netEdgeBps };
      low = size;
    } else if (notional < config.parityMinTradeUsd || notional < config.parityMinDepthUsd) {
      low = size;
    } else {
      high = size;
    }
  }
  return best;
}

export function scanPolyParity(
  markets: PolyMarket[],
  booksByCondition: Map<string, PolyTokenBookPair>,
  config: PolyConfig,
): PolyParityPlan[] {
  if (!config.enableParityLane) return [];
  const plans: PolyParityPlan[] = [];
  for (const market of markets) {
    const pair = booksByCondition.get(market.conditionId);
    if (!pair?.yesBook || !pair.noBook) continue;
    const asks = bestParitySize(
      pair.yesBook.asks,
      pair.noBook.asks,
      config,
      (yes, no) => (1 - yes - no) * 10_000,
      (size, yes, no) => size * (yes + no),
    );
    if (asks) {
      const notional = asks.size * (asks.yes + asks.no);
      plans.push({
        type: "PARITY",
        conditionId: market.conditionId,
        marketSlug: market.marketSlug,
        title: market.title,
        sizeShares: asks.size,
        yesPrice: asks.yes,
        noPrice: asks.no,
        notionalUsd: notional,
        grossEdgeBps: asks.edgeBps,
        estimatedNetEdgeBps: asks.netEdgeBps,
        expectedGrossPnlUsd: asks.size - notional,
        warnings: [],
      });
    }
    const bids = bestParitySize(
      pair.yesBook.bids,
      pair.noBook.bids,
      config,
      (yes, no) => (yes + no - 1) * 10_000,
      (size) => size,
    );
    if (bids) {
      const proceeds = bids.size * (bids.yes + bids.no);
      plans.push({
        type: "SPLIT_MERGE",
        conditionId: market.conditionId,
        marketSlug: market.marketSlug,
        title: market.title,
        sizeShares: bids.size,
        yesPrice: bids.yes,
        noPrice: bids.no,
        notionalUsd: bids.size,
        grossEdgeBps: bids.edgeBps,
        estimatedNetEdgeBps: bids.netEdgeBps,
        expectedGrossPnlUsd: proceeds - bids.size,
        warnings: ["observation only; split/sell execution not enabled"],
      });
    }
  }
  return plans.sort((a, b) => b.estimatedNetEdgeBps - a.estimatedNetEdgeBps);
}
