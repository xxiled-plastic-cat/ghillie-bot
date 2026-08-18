import {
  type AlphaMarket,
  type AlphaOrderbook,
  type AlphaOrderSide,
  type AlphaOutcome,
  type AlphaPaperOrder,
  POOL_FALLBACK_DAILY_REWARD_SOURCE,
} from "./alphaTypes.js";

/**
 * A market's daily reward in USD, but only when it is a genuine, non-zero daily
 * emission. Pool-fallback figures (whole pool treated as a day) are fabricated
 * overstatements that on-chain pay ~$0, so they are reported as no income.
 */
export function reliableDailyRewardUsd(market: AlphaMarket | undefined): number | undefined {
  const daily = market?.reward.dailyRewardsUsd;
  if (daily === undefined || !Number.isFinite(daily) || daily <= 0) return undefined;
  if (market?.reward.dailyRewardsSource === POOL_FALLBACK_DAILY_REWARD_SOURCE) return undefined;
  return daily;
}

type BookLevel = {
  price: number;
  quantityShares: number;
  owner?: string;
};

export type RewardRateContext = {
  markets?: Iterable<AlphaMarket> | Map<number, AlphaMarket>;
  orderbooks?: Map<number, AlphaOrderbook>;
  walletAddress?: string;
  /**
   * Empirical multiplier applied to the estimated reward $ rate (not the
   * liquidity share) so the projection can be aligned to measured payouts.
   * Defaults to 1 (no adjustment).
   */
  calibration?: number;
};

export type RewardRateEstimate = {
  dailyUsd?: number;
  hourlyUsd?: number;
  liquidityShare?: number;
  ownContracts: number;
  totalEligibleContracts?: number;
  estimatedMarkets: number;
  unknownMarkets: number;
};

const PRICE_EPSILON = 0.000001;

function toMarketMap(markets: RewardRateContext["markets"]): Map<number, AlphaMarket> {
  if (!markets) return new Map();
  if (markets instanceof Map) return markets;
  return new Map([...markets].map((market) => [market.marketAppId, market]));
}

function groupOrdersByMarket(orders: AlphaPaperOrder[]): Map<number, AlphaPaperOrder[]> {
  const byMarket = new Map<number, AlphaPaperOrder[]>();
  for (const order of orders) {
    const existing = byMarket.get(order.marketAppId) ?? [];
    existing.push(order);
    byMarket.set(order.marketAppId, existing);
  }
  return byMarket;
}

function maxRewardSpreadCents(market: AlphaMarket | undefined): number | undefined {
  const spread = market?.reward.maxRewardSpreadCents;
  return spread !== undefined && Number.isFinite(spread) && spread > 0 ? spread : undefined;
}

function rewardMinContracts(market: AlphaMarket | undefined, orders: AlphaPaperOrder[]): number {
  return Math.max(
    0,
    market?.reward.minContracts ?? 0,
    ...orders
      .map((order) => order.rewardMinContracts ?? 0)
      .filter((value) => Number.isFinite(value)),
  );
}

function midpointFor(book: AlphaOrderbook, outcome: AlphaOutcome): number | undefined {
  return outcome === "YES" ? book.yesMid : book.noMid;
}

function levelsFor(book: AlphaOrderbook, outcome: AlphaOutcome, side: AlphaOrderSide): BookLevel[] {
  const outcomeOrders = outcome === "YES" ? book.yesSideOrders : book.noSideOrders;
  return side === "bid" ? outcomeOrders.bids : outcomeOrders.asks;
}

function insideRewardZone(
  price: number,
  midpoint: number | undefined,
  maxSpreadCentsValue: number,
): boolean {
  if (midpoint === undefined || !Number.isFinite(midpoint)) return false;
  return Math.abs(price - midpoint) * 100 <= maxSpreadCentsValue + PRICE_EPSILON;
}

function orderInsideRewardZone(
  order: AlphaPaperOrder,
  book: AlphaOrderbook,
  maxSpreadCentsValue: number,
): boolean {
  return insideRewardZone(order.price, midpointFor(book, order.outcome), maxSpreadCentsValue);
}

function totalRewardZoneContracts(
  book: AlphaOrderbook,
  maxSpreadCentsValue: number,
): number | undefined {
  if (book.source === "unavailable") return undefined;

  let contracts = 0;
  for (const outcome of ["YES", "NO"] as const) {
    const midpoint = midpointFor(book, outcome);
    for (const side of ["bid", "ask"] as const) {
      for (const level of levelsFor(book, outcome, side)) {
        if (!insideRewardZone(level.price, midpoint, maxSpreadCentsValue)) continue;
        contracts += level.quantityShares;
      }
    }
  }
  return contracts;
}

function estimateMarketRewardShare(
  orders: AlphaPaperOrder[],
  market: AlphaMarket | undefined,
  book: AlphaOrderbook | undefined,
): { share: number; ownContracts: number; totalEligibleContracts: number } | undefined {
  const maxSpread = maxRewardSpreadCents(market);
  if (maxSpread === undefined || !book) return undefined;

  const minContracts = rewardMinContracts(market, orders);
  const ownContracts = orders
    .filter((order) => orderInsideRewardZone(order, book, maxSpread))
    .reduce((sum, order) => sum + order.remainingShares, 0);
  if (ownContracts <= 0) return { share: 0, ownContracts: 0, totalEligibleContracts: 0 };
  if (ownContracts + PRICE_EPSILON < minContracts)
    return { share: 0, ownContracts, totalEligibleContracts: ownContracts };

  const eligibleContracts = totalRewardZoneContracts(book, maxSpread);
  if (eligibleContracts === undefined) return undefined;
  const totalEligibleContracts = Math.max(eligibleContracts, ownContracts);
  if (totalEligibleContracts <= 0) return { share: 0, ownContracts, totalEligibleContracts: 0 };

  return {
    share: Math.min(1, ownContracts / totalEligibleContracts),
    ownContracts,
    totalEligibleContracts,
  };
}

export function estimateRewardRateForOrders(
  orders: AlphaPaperOrder[],
  context: RewardRateContext = {},
): RewardRateEstimate {
  if (orders.length === 0) {
    return {
      dailyUsd: 0,
      hourlyUsd: 0,
      liquidityShare: 0,
      ownContracts: 0,
      totalEligibleContracts: 0,
      estimatedMarkets: 0,
      unknownMarkets: 0,
    };
  }

  const marketByAppId = toMarketMap(context.markets);
  const orderbooks = context.orderbooks ?? new Map<number, AlphaOrderbook>();
  const ordersByMarket = groupOrdersByMarket(orders);
  let dailyUsd = 0;
  let rewardWeightedShare = 0;
  let rewardWeight = 0;
  let ownContracts = 0;
  let totalEligibleContracts = 0;
  let estimatedMarkets = 0;
  let unknownMarkets = 0;

  for (const [marketAppId, marketOrders] of ordersByMarket) {
    const market = marketByAppId.get(marketAppId);
    const book = orderbooks.get(marketAppId);
    // Only count income from markets with a genuine daily emission. Pool-fallback
    // markets (and the per-order estimates derived from them) are excluded so the
    // reward rate, liquidity share, and accrual never claim fabricated income.
    const dailyRewardUsd = reliableDailyRewardUsd(market);
    if (dailyRewardUsd === undefined || dailyRewardUsd <= 0) continue;

    const share = estimateMarketRewardShare(marketOrders, market, book);
    if (!share) {
      unknownMarkets += 1;
      continue;
    }

    estimatedMarkets += 1;
    dailyUsd += dailyRewardUsd * share.share;
    rewardWeightedShare += dailyRewardUsd * share.share;
    rewardWeight += dailyRewardUsd;
    ownContracts += share.ownContracts;
    totalEligibleContracts += share.totalEligibleContracts;
  }

  if (unknownMarkets > 0) {
    return {
      ownContracts,
      totalEligibleContracts: totalEligibleContracts || undefined,
      estimatedMarkets,
      unknownMarkets,
    };
  }

  const calibration =
    context.calibration !== undefined && context.calibration > 0 ? context.calibration : 1;
  const calibratedDailyUsd = dailyUsd * calibration;
  return {
    dailyUsd: calibratedDailyUsd,
    hourlyUsd: calibratedDailyUsd / 24,
    liquidityShare: rewardWeight > 0 ? rewardWeightedShare / rewardWeight : 0,
    ownContracts,
    totalEligibleContracts,
    estimatedMarkets,
    unknownMarkets,
  };
}
