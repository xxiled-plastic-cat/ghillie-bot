import { getMarkets, getOraclePrices, getRewardMarkets } from "../clients/div3rsaClient.js";
import type { Ladder, Market, RewardMarket } from "../types/market.js";
import { getHaltWindowMinutes, minutesUntil, normalizePrice } from "../utils/math.js";

export type ScannerConfig = {
  minHaltBufferMinutes: number;
};

function completeComplementaryPrices(market: Market): Market {
  const directYesBid = market.yesBid;
  const directYesAsk = market.yesAsk;
  const directNoBid = market.noBid;
  const directNoAsk = market.noAsk;

  const derivedNoAsk = directYesBid !== undefined ? normalizePrice(1 - directYesBid) : undefined;
  const derivedNoBid = directYesAsk !== undefined ? normalizePrice(1 - directYesAsk) : undefined;
  const derivedYesAsk = directNoBid !== undefined ? normalizePrice(1 - directNoBid) : undefined;
  const derivedYesBid = directNoAsk !== undefined ? normalizePrice(1 - directNoAsk) : undefined;

  return {
    ...market,
    yesBid: directYesBid ?? derivedYesBid,
    yesAsk: directYesAsk ?? derivedYesAsk,
    noBid: directNoBid ?? derivedNoBid,
    noAsk: directNoAsk ?? derivedNoAsk,
  };
}

function hasPositiveHaltBuffer(market: Market, minBufferMinutes: number): boolean {
  const haltTs = market.haltTs ?? market.expiryTs - getHaltWindowMinutes(market.timeframe) * 60;
  return minutesUntil(haltTs) > minBufferMinutes;
}

function isValidOpenMarket(market: Market, minBufferMinutes: number): boolean {
  if (market.status !== "open") return false;
  if (!Number.isFinite(market.strike) || !Number.isFinite(market.expiryTs)) return false;
  if (!hasPositiveHaltBuffer(market, minBufferMinutes)) return false;
  return true;
}

export function groupIntoLadders(markets: Market[]): Ladder[] {
  const byLadder = new Map<string, Ladder>();
  for (const market of markets) {
    const key = `${market.underlying}:${market.timeframe}:${market.expiryTs}`;
    const existing = byLadder.get(key);
    if (existing) {
      existing.markets.push(market);
      continue;
    }
    byLadder.set(key, {
      underlying: market.underlying,
      timeframe: market.timeframe,
      expiryTs: market.expiryTs,
      markets: [market],
    });
  }
  return [...byLadder.values()]
    .map((ladder) => ({
      ...ladder,
      markets: [...ladder.markets].sort((a, b) => a.strike - b.strike),
    }))
    .filter((ladder) => ladder.markets.length >= 2);
}

export async function loadScanInputs(config: ScannerConfig): Promise<{
  allMarkets: Market[];
  openMarkets: Market[];
  ladders: Ladder[];
  rewardMarkets: RewardMarket[];
}> {
  const [rawMarkets, oraclePrices, rewardMarkets] = await Promise.all([
    getMarkets(),
    getOraclePrices(),
    getRewardMarkets(),
  ]);

  const oracleByUnderlying = new Map<string, number>();
  for (const oracle of oraclePrices) {
    oracleByUnderlying.set(oracle.underlying, oracle.price);
  }

  const allMarkets = rawMarkets.map((market) =>
    completeComplementaryPrices({
      ...market,
      oraclePrice: oracleByUnderlying.get(market.underlying),
    }),
  );
  const openMarkets = allMarkets.filter((market) =>
    isValidOpenMarket(market, config.minHaltBufferMinutes),
  );
  const ladders = groupIntoLadders(openMarkets);

  return { allMarkets, openMarkets, ladders, rewardMarkets };
}
