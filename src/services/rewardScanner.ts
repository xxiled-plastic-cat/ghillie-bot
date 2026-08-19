import type {
  LiquiditySignal,
  MakerCandidate,
  Market,
  RewardMarket,
  Timeframe,
} from "../types/market.js";
import { getHaltWindowMinutes, minutesUntil } from "../utils/math.js";

type RewardScanOptions = {
  maxSpreadCents: number;
  minHaltBufferMinutes: number;
};

function getMarketRewardBoost(market: Market, rewardByMarket: Map<string, RewardMarket>): number {
  const marketGroupId = market.marketGroupId ?? market.id.split(":")[0] ?? market.id;
  const reward = rewardByMarket.get(marketGroupId);
  if (!reward) return 0;
  return Math.min(reward.allocation / 1_000, 1);
}

function getRewardAllocation(market: Market, rewardByMarket: Map<string, RewardMarket>): number {
  const marketGroupId = market.marketGroupId ?? market.id.split(":")[0] ?? market.id;
  return rewardByMarket.get(marketGroupId)?.allocation ?? 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToTick(value: number, tick = 0.01): number {
  return Math.round(value / tick) * tick;
}

function getBookState(market: Market): "two_sided" | "one_sided" | "empty" {
  const values = [market.yesBid, market.yesAsk, market.noBid, market.noAsk];
  const available = values.filter((x) => x !== undefined).length;
  if (available === 0) return "empty";
  if (available === values.length) return "two_sided";
  return "one_sided";
}

function getFairWidth(timeframe: Timeframe): number {
  if (timeframe === "hourly") return 0.01;
  if (timeframe === "daily") return 0.025;
  if (timeframe === "weekly") return 0.05;
  if (timeframe === "monthly") return 0.08;
  return 0.03;
}

function estimateYesFairPrice(market: Market): number {
  if (!market.oraclePrice || market.oraclePrice <= 0) return 0.5;
  const width = market.oraclePrice * getFairWidth(market.timeframe);
  if (width <= 0) return 0.5;
  const normalizedDistance = (market.oraclePrice - market.strike) / width;
  return clamp(0.5 + normalizedDistance * 0.5, 0.05, 0.95);
}

function getSuggestedTwoSidedQuotes(
  mid: number,
  spread: number,
): {
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
} {
  const halfSpread = spread / 2;
  const yesBid = clamp(roundToTick(mid - halfSpread), 0.01, 0.98);
  const yesAsk = clamp(roundToTick(mid + halfSpread), 0.02, 0.99);
  const noBid = clamp(roundToTick(1 - yesAsk), 0.01, 0.98);
  const noAsk = clamp(roundToTick(1 - yesBid), 0.02, 0.99);
  return { yesBid, yesAsk, noBid, noAsk };
}

export function rankMakerCandidates(
  markets: Market[],
  rewardMarkets: RewardMarket[],
  options: RewardScanOptions,
): MakerCandidate[] {
  const maxSpread = options.maxSpreadCents / 100;
  const rewardByMarket = new Map(rewardMarkets.map((market) => [market.marketId, market]));
  const candidates: MakerCandidate[] = [];

  for (const market of markets) {
    if (
      market.yesBid === undefined ||
      market.yesAsk === undefined ||
      market.noBid === undefined ||
      market.noAsk === undefined
    ) {
      continue;
    }

    const yesMid = (market.yesBid + market.yesAsk) / 2;
    const spread = market.yesAsk - market.yesBid;
    if (spread <= 0 || spread > maxSpread) continue;
    if (yesMid < 0.1) continue;

    const haltTs = market.haltTs ?? market.expiryTs - getHaltWindowMinutes(market.timeframe) * 60;
    const minsToHalt = minutesUntil(haltTs);
    if (minsToHalt <= options.minHaltBufferMinutes) continue;

    const atmWeight = 1 - Math.abs(yesMid - 0.5) / 0.5;
    const spreadRoomWeight = Math.min(spread / maxSpread, 1);
    const haltWeight = Math.min(minsToHalt / 180, 1);
    const rewardWeight = getMarketRewardBoost(market, rewardByMarket);
    const score =
      atmWeight * 0.55 + spreadRoomWeight * 0.25 + haltWeight * 0.1 + rewardWeight * 0.1;

    const reason = `near-ATM=${atmWeight.toFixed(2)}, spread=${(spread * 100).toFixed(
      2,
    )}c, haltBuffer=${minsToHalt.toFixed(1)}m`;
    candidates.push({
      type: "maker_candidate",
      marketId: market.id,
      underlying: market.underlying,
      timeframe: market.timeframe,
      strike: market.strike,
      expiryTs: market.expiryTs,
      yesMid,
      spread,
      atmWeight,
      reason,
      score,
    });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

export function rankLiquiditySignals(
  markets: Market[],
  rewardMarkets: RewardMarket[],
  options: RewardScanOptions,
): LiquiditySignal[] {
  const maxSpread = options.maxSpreadCents / 100;
  const rewardByMarket = new Map(rewardMarkets.map((market) => [market.marketId, market]));
  const signals: LiquiditySignal[] = [];

  for (const market of markets) {
    const haltTs = market.haltTs ?? market.expiryTs - getHaltWindowMinutes(market.timeframe) * 60;
    const minsToHalt = minutesUntil(haltTs);
    if (minsToHalt <= options.minHaltBufferMinutes) continue;

    const rewardBoost = getMarketRewardBoost(market, rewardByMarket);
    const rewardAllocation = getRewardAllocation(market, rewardByMarket);
    const bookState = getBookState(market);
    const fairYes = estimateYesFairPrice(market);

    const directYesMid =
      market.yesBid !== undefined && market.yesAsk !== undefined
        ? (market.yesBid + market.yesAsk) / 2
        : undefined;
    const directSpread =
      market.yesBid !== undefined && market.yesAsk !== undefined
        ? market.yesAsk - market.yesBid
        : undefined;

    if (
      bookState === "two_sided" &&
      directYesMid !== undefined &&
      directSpread !== undefined &&
      directSpread > 0
    ) {
      const yesMid = directYesMid;
      const spread = directSpread;
      const atmWeight = 1 - Math.abs(yesMid - 0.5) / 0.5;
      const spreadRoom = Math.min(spread / maxSpread, 1);
      const haltWeight = Math.min(minsToHalt / 180, 1);
      const score = atmWeight * 0.35 + spreadRoom * 0.25 + rewardBoost * 0.2 + haltWeight * 0.2;
      const quotingSpread = clamp(Math.min(spread - 0.01, maxSpread / 2), 0.01, maxSpread / 2);
      const quotes = getSuggestedTwoSidedQuotes(yesMid, quotingSpread);
      signals.push({
        type: "liquidity_signal",
        kind: "improve_quote",
        marketId: market.id,
        marketGroupId: market.marketGroupId,
        strikeIndex: market.strikeIndex,
        haltTs: market.haltTs,
        underlying: market.underlying,
        timeframe: market.timeframe,
        strike: market.strike,
        expiryTs: market.expiryTs,
        score,
        reason: `two-sided book with quote-improvement room (${(spread * 100).toFixed(
          2,
        )}c spread), reward allocation=${rewardAllocation.toFixed(2)}`,
        yesMid,
        spread,
        rewardAllocation,
        haltBufferMinutes: minsToHalt,
        bookState,
        suggestedYesBid: quotes.yesBid,
        suggestedYesAsk: quotes.yesAsk,
        suggestedNoBid: quotes.noBid,
        suggestedNoAsk: quotes.noAsk,
      });
      continue;
    }

    const yesMid = directYesMid ?? fairYes;
    const seedSpread = clamp(maxSpread * 0.3, 0.02, 0.06);
    const quotes = getSuggestedTwoSidedQuotes(yesMid, seedSpread);
    const atmWeight = 1 - Math.abs(fairYes - 0.5) / 0.5;
    const haltWeight = Math.min(minsToHalt / 180, 1);
    const bookStateWeight = bookState === "empty" ? 1 : 0.6;
    const score =
      atmWeight * 0.25 + rewardBoost * 0.35 + haltWeight * 0.25 + bookStateWeight * 0.15;
    const seedContext =
      bookState === "two_sided"
        ? "book has no inside room (tight/locked spread)"
        : `thin book (${bookState})`;
    signals.push({
      type: "liquidity_signal",
      kind: "seed_liquidity",
      marketId: market.id,
      marketGroupId: market.marketGroupId,
      strikeIndex: market.strikeIndex,
      haltTs: market.haltTs,
      underlying: market.underlying,
      timeframe: market.timeframe,
      strike: market.strike,
      expiryTs: market.expiryTs,
      score,
      reason: `${seedContext}; seed two-sided quotes around fair=${fairYes.toFixed(
        2,
      )} with reward allocation=${rewardAllocation.toFixed(2)}`,
      yesMid,
      spread: seedSpread,
      rewardAllocation,
      haltBufferMinutes: minsToHalt,
      bookState,
      suggestedYesBid: quotes.yesBid,
      suggestedYesAsk: quotes.yesAsk,
      suggestedNoBid: quotes.noBid,
      suggestedNoAsk: quotes.noAsk,
    });
  }

  return signals.sort((a, b) => b.score - a.score);
}
