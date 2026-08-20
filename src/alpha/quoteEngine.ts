import { roundShares } from "./alphaClient.js";
import type { AlphaConfig } from "./alphaConfig.js";
import {
  type AlphaBotState,
  type AlphaMarket,
  type AlphaOrderbook,
  type AlphaOutcome,
  type AlphaQuote,
  POOL_FALLBACK_DAILY_REWARD_SOURCE,
} from "./alphaTypes.js";
import { getPosition } from "./inventoryView.js";

const CONTROLLED_UNDERWATER_EXIT_REASON = "controlled underwater exit";

/**
 * Whether the reward lane should commit capital to this market. We only farm
 * markets that advertise a genuine, non-zero daily emission. When the API does
 * not expose a real daily figure the client falls back to treating the whole
 * reward pool as a "daily" number, which massively overstates the rate; such
 * markets historically pay ~$0, so the reward lane self-disables on them.
 */
export function rewardLaneAllowsMarket(market: AlphaMarket, config: AlphaConfig): boolean {
  if (!market.reward.isRewardMarket) return false;
  if (!config.rewardRequireRealDaily) return true;
  const daily = market.reward.dailyRewardsUsd;
  if (daily === undefined || daily <= 0) return false;
  return market.reward.dailyRewardsSource !== POOL_FALLBACK_DAILY_REWARD_SOURCE;
}

function getOutcomeBook(
  book: AlphaOrderbook,
  outcome: AlphaOutcome,
): { bid?: number; ask?: number; mid?: number; spread?: number } {
  return outcome === "YES"
    ? { bid: book.yesBid, ask: book.yesAsk, mid: book.yesMid, spread: book.yesSpread }
    : { bid: book.noBid, ask: book.noAsk, mid: book.noMid, spread: book.noSpread };
}

function quoteSize(
  price: number,
  notionalUsd: number,
): { sizeShares: number; notionalUsd: number } | undefined {
  if (price <= 0 || price >= 1) return undefined;
  const sizeShares = roundShares(notionalUsd / price);
  if (sizeShares <= 0) return undefined;
  return { sizeShares, notionalUsd: price * sizeShares };
}

function laneNotionalUsd(
  targetUsd: number,
  minUsd: number,
  maxUsd: number,
  enforceMin: boolean,
): number | undefined {
  const cappedMax = Math.max(0, maxUsd);
  if (cappedMax <= 0) return undefined;
  const desired = Math.min(Math.max(targetUsd, 0), cappedMax);
  if (!enforceMin) return desired > 0 ? desired : undefined;
  const minRequired = Math.max(minUsd, 0);
  if (cappedMax < minRequired) return undefined;
  return Math.max(desired, minRequired);
}

function positionShares(state: AlphaBotState, marketAppId: number, outcome: AlphaOutcome): number {
  const position = getPosition(state, marketAppId);
  if (!position) return 0;
  return outcome === "YES" ? position.yesShares : position.noShares;
}

function positionAverageCost(
  state: AlphaBotState,
  marketAppId: number,
  outcome: AlphaOutcome,
): number | undefined {
  const position = getPosition(state, marketAppId);
  if (!position) return undefined;
  const averageCost = outcome === "YES" ? position.avgYesCost : position.avgNoCost;
  return averageCost > 0 ? averageCost : undefined;
}

function outcomeAgeSeconds(
  state: AlphaBotState,
  marketAppId: number,
  outcome: AlphaOutcome,
  now = Date.now(),
): number | undefined {
  const timestamps: number[] = [];
  for (const order of state.openOrders) {
    if (
      order.runMode !== "live" ||
      order.marketAppId !== marketAppId ||
      order.outcome !== outcome ||
      order.side !== "bid"
    )
      continue;
    const created = Date.parse(order.createdAt);
    if (Number.isFinite(created)) timestamps.push(created);
  }
  for (const fill of state.fills) {
    if (
      fill.runMode !== "live" ||
      fill.marketAppId !== marketAppId ||
      fill.outcome !== outcome ||
      fill.side !== "bid"
    )
      continue;
    const when = Date.parse(fill.updatedAt ?? fill.createdAt);
    if (Number.isFinite(when)) timestamps.push(when);
  }
  if (timestamps.length === 0) return undefined;
  return Math.max(0, (now - Math.min(...timestamps)) / 1000);
}

function expectedLossUsd(averageCost: number, ask: number, shares: number): number {
  return Math.max(0, (averageCost - ask) * shares);
}

function entryLegKey(quote: Pick<AlphaQuote, "outcome" | "side" | "source">): string {
  return `${quote.outcome}:${quote.side}:${quote.source}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

/**
 * Amarok `get_quotes` rows attached by `scanFromAmarok` (`suggestedQuotes` or
 * legacy `raw.amarokQuotes`). Inventory-exit asks are never taken from Amarok.
 */
export function suggestedQuotesFromMarket(market: AlphaMarket): AlphaQuote[] {
  if (market.suggestedQuotes && market.suggestedQuotes.length > 0) {
    return market.suggestedQuotes;
  }
  const raw = isRecord(market.raw) ? market.raw.amarokQuotes : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter((row): row is AlphaQuote => {
    if (!isRecord(row)) return false;
    return (
      typeof row.price === "number" &&
      typeof row.sizeShares === "number" &&
      (row.outcome === "YES" || row.outcome === "NO") &&
      (row.side === "bid" || row.side === "ask") &&
      (row.source === "reward" || row.source === "spread" || row.source === "inventory_exit")
    );
  });
}

function laneEnabledForSource(source: AlphaQuote["source"], config: AlphaConfig): boolean {
  if (source === "reward") return config.enableRewardLane;
  if (source === "spread") return config.enableSpreadLane && config.enableSpreadCapture;
  return false;
}

function adoptAmarokSuggestedQuote(
  quote: AlphaQuote,
  market: AlphaMarket,
  config: AlphaConfig,
): AlphaQuote | undefined {
  if (quote.marketAppId !== market.marketAppId) return undefined;
  if (quote.side !== "bid") return undefined;
  if (quote.source !== "reward" && quote.source !== "spread") return undefined;
  if (!laneEnabledForSource(quote.source, config)) return undefined;
  if (quote.source === "reward" && !rewardLaneAllowsMarket(market, config)) return undefined;
  if (!(quote.price > 0 && quote.price < 1)) return undefined;
  if (!(quote.sizeShares > 0)) return undefined;

  const maxUsd =
    quote.source === "reward" ? config.rewardMaxOrderSizeUsd : config.spreadMaxOrderSizeUsd;
  const rawNotional = quote.notionalUsd > 0 ? quote.notionalUsd : quote.price * quote.sizeShares;
  const sized =
    rawNotional <= maxUsd + 1e-9
      ? { sizeShares: quote.sizeShares, notionalUsd: rawNotional }
      : quoteSize(quote.price, maxUsd);
  if (!sized) return undefined;

  const reason = /amarok/i.test(quote.reason) ? quote.reason : `Amarok suggested: ${quote.reason}`;
  return {
    ...quote,
    id: quote.id || `amarok:${market.marketAppId}:${quote.outcome}:${quote.side}:${quote.source}`,
    marketId: market.id,
    marketAppId: market.marketAppId,
    slug: market.slug ?? quote.slug,
    title: market.title,
    sizeShares: sized.sizeShares,
    notionalUsd: sized.notionalUsd,
    reason,
    estimatedRewardUsdPerDay: quote.estimatedRewardUsdPerDay ?? market.reward.dailyRewardsUsd,
  };
}

function existingControlledMarketLossUsd(state: AlphaBotState, marketAppId: number): number {
  return state.openOrders
    .filter(
      (order) =>
        order.runMode === "live" &&
        order.status === "open" &&
        order.marketAppId === marketAppId &&
        order.source === "inventory_exit" &&
        order.side === "ask" &&
        order.reason.startsWith(CONTROLLED_UNDERWATER_EXIT_REASON),
    )
    .reduce((sum, order) => {
      const position = getPosition(state, order.marketAppId);
      const averageCost = order.outcome === "YES" ? position?.avgYesCost : position?.avgNoCost;
      if (averageCost === undefined || averageCost <= 0) return sum;
      return sum + expectedLossUsd(averageCost, order.price, order.remainingShares);
    }, 0);
}

function insideSpreadBid(
  book: { bid?: number; ask?: number; mid?: number; spread?: number },
  config: AlphaConfig,
): number | undefined {
  if (
    !config.enableSpreadCapture ||
    book.bid === undefined ||
    book.ask === undefined ||
    book.mid === undefined ||
    book.spread === undefined
  ) {
    return undefined;
  }
  if (book.spread * 100 < config.minSpreadCaptureCents) return undefined;
  const edge = Math.min(config.spreadExitEdgeCents / 100, book.spread / 4);
  const bid = Math.min(book.mid - edge, book.ask - 0.000001);
  if (bid <= book.bid || bid >= book.ask) return undefined;
  return bid;
}

function insideSpreadAsk(
  book: { bid?: number; ask?: number; mid?: number; spread?: number },
  config: AlphaConfig,
  options: { requireSpreadCapture: boolean } = { requireSpreadCapture: true },
): number | undefined {
  if (
    (options.requireSpreadCapture && !config.enableSpreadCapture) ||
    book.bid === undefined ||
    book.mid === undefined
  ) {
    return undefined;
  }
  // When there is no visible ask side, still post an unwind ask above best bid
  // so inventory can start offloading instead of waiting for a full two-sided book.
  if (book.ask === undefined || book.spread === undefined) {
    const syntheticAsk = Math.min(
      0.999999,
      Math.max(book.mid + config.spreadExitEdgeCents / 100, book.bid + 0.000001),
    );
    return syntheticAsk > book.bid ? syntheticAsk : undefined;
  }
  const edge = Math.min(config.spreadExitEdgeCents / 100, book.spread / 4);
  const ask = Math.max(book.mid + edge, book.bid + 0.000001);
  if (ask <= book.bid || ask >= book.ask) return undefined;
  return ask;
}

export function generateQuotes(
  market: AlphaMarket,
  book: AlphaOrderbook,
  state: AlphaBotState,
  config: AlphaConfig,
): AlphaQuote[] {
  const quotes: AlphaQuote[] = [];
  const coveredLegs = new Set<string>();
  for (const suggested of suggestedQuotesFromMarket(market)) {
    const adopted = adoptAmarokSuggestedQuote(suggested, market, config);
    if (!adopted) continue;
    const key = entryLegKey(adopted);
    if (coveredLegs.has(key)) continue;
    coveredLegs.add(key);
    quotes.push(adopted);
  }

  const rewardLaneEnabled = config.enableRewardLane;
  const rewardLaneMarket = rewardLaneAllowsMarket(market, config);
  const spreadLaneEnabled = config.enableSpreadLane && config.enableSpreadCapture;
  const exitsEnabled = config.enableRewardLane || config.enableSpreadLane;
  for (const outcome of ["YES", "NO"] as const) {
    const outcomeBook = getOutcomeBook(book, outcome);
    const midpoint = outcomeBook.mid;
    if (midpoint === undefined) continue;
    const rewardSpread =
      market.reward.maxRewardSpreadCents !== undefined
        ? market.reward.maxRewardSpreadCents / 100
        : undefined;
    const rewardMinContracts = market.reward.isRewardMarket
      ? market.reward.minContracts
      : undefined;
    const rewardBuffer = config.rewardZoneBufferCents / 100;
    const spread = outcomeBook.spread;
    const rewardMidpointAllowed = midpoint >= config.minMidpoint && midpoint <= config.maxMidpoint;
    const spreadEntryMidpointAllowed =
      midpoint >= config.minSpreadEntryMidpoint && midpoint <= config.maxSpreadMidpoint;
    const spreadExitMidpointAllowed =
      midpoint >= config.minSpreadExitMidpoint && midpoint <= config.maxSpreadMidpoint;
    let bid =
      rewardLaneEnabled && rewardLaneMarket && rewardSpread !== undefined && rewardMidpointAllowed
        ? midpoint - rewardBuffer
        : undefined;
    if (bid !== undefined && outcomeBook.ask !== undefined && bid >= outcomeBook.ask) {
      bid = outcomeBook.ask - 0.01;
    }
    if (
      bid !== undefined &&
      bid > 0 &&
      (rewardSpread === undefined || Math.abs(midpoint - bid) <= rewardSpread) &&
      (spread === undefined ||
        spread * 100 >= config.minMakerSpreadCents ||
        market.reward.isRewardMarket)
    ) {
      const rewardEligible =
        market.reward.isRewardMarket &&
        rewardSpread !== undefined &&
        Math.abs(midpoint - bid) <= rewardSpread;
      // Size reward bids so a single resting order satisfies the market's
      // aggregate minimum-contract requirement on its own. A 0.5% buffer
      // absorbs share-rounding so the placed order does not land fractionally
      // under the minimum. If that minimum cannot be funded within the lane's
      // max order size, emit no reward bid at all rather than resting capital
      // that can never qualify for rewards.
      const minContractsNotionalUsd =
        rewardEligible && rewardMinContracts !== undefined ? rewardMinContracts * bid * 1.005 : 0;
      const meetsMinWithinCap = minContractsNotionalUsd <= config.rewardMaxOrderSizeUsd + 1e-9;
      const rewardNotionalUsd =
        rewardEligible && rewardMinContracts !== undefined && !meetsMinWithinCap
          ? undefined
          : laneNotionalUsd(
              Math.max(config.rewardTargetQuoteSizeUsd, minContractsNotionalUsd),
              config.rewardMinOrderSizeUsd,
              config.rewardMaxOrderSizeUsd,
              true,
            );
      const sized = rewardNotionalUsd === undefined ? undefined : quoteSize(bid, rewardNotionalUsd);
      const meetsMinContracts =
        !rewardEligible ||
        rewardMinContracts === undefined ||
        (sized !== undefined && sized.sizeShares + 1e-9 >= rewardMinContracts);
      if (sized && meetsMinContracts) {
        const source: AlphaQuote["source"] = market.reward.isRewardMarket ? "reward" : "spread";
        if (!coveredLegs.has(entryLegKey({ outcome, side: "bid", source }))) {
          quotes.push({
            id: `${market.marketAppId}:${outcome}:bid:${Date.now()}`,
            marketId: market.id,
            marketAppId: market.marketAppId,
            slug: market.slug,
            title: market.title,
            outcome,
            side: "bid",
            price: bid,
            ...sized,
            reason: rewardEligible
              ? "reward-zone bid near midpoint; market minimum checked in aggregate"
              : "spread-capture bid",
            rewardEligible,
            rewardZoneDistanceCents:
              rewardSpread !== undefined ? Math.abs(midpoint - bid) * 100 : undefined,
            rewardMinContracts,
            estimatedRewardUsdPerDay: market.reward.dailyRewardsUsd,
            source,
          });
        }
      }
    }

    const spreadBid =
      spreadLaneEnabled && spreadEntryMidpointAllowed
        ? insideSpreadBid(outcomeBook, config)
        : undefined;
    if (spreadBid !== undefined) {
      const spreadNotionalUsd = laneNotionalUsd(
        config.spreadTargetOrderSizeUsd,
        config.spreadMinOrderSizeUsd,
        config.spreadMaxOrderSizeUsd,
        true,
      );
      const sized =
        spreadNotionalUsd === undefined ? undefined : quoteSize(spreadBid, spreadNotionalUsd);
      if (sized && !coveredLegs.has(entryLegKey({ outcome, side: "bid", source: "spread" }))) {
        quotes.push({
          id: `${market.marketAppId}:${outcome}:spread-bid:${Date.now()}`,
          marketId: market.id,
          marketAppId: market.marketAppId,
          slug: market.slug,
          title: market.title,
          outcome,
          side: "bid",
          price: spreadBid,
          ...sized,
          reason: `spread-capture bid inside ${((outcomeBook.spread ?? 0) * 100).toFixed(2)}c spread`,
          rewardEligible: false,
          rewardZoneDistanceCents:
            rewardSpread !== undefined ? Math.abs(midpoint - spreadBid) * 100 : undefined,
          rewardMinContracts,
          estimatedRewardUsdPerDay: market.reward.dailyRewardsUsd,
          source: "spread",
        });
      }
    }

    const inventory = positionShares(state, market.marketAppId, outcome);
    if (inventory <= 0) continue;
    if (!exitsEnabled) continue;
    const averageCost = positionAverageCost(state, market.marketAppId, outcome);
    const positionAgeSeconds = outcomeAgeSeconds(state, market.marketAppId, outcome);
    let ask =
      market.reward.isRewardMarket && rewardSpread !== undefined && rewardMidpointAllowed
        ? midpoint + rewardBuffer
        : spreadExitMidpointAllowed
          ? insideSpreadAsk(outcomeBook, config, { requireSpreadCapture: false })
          : undefined;
    if (ask !== undefined && outcomeBook.bid !== undefined && ask <= outcomeBook.bid) {
      ask = outcomeBook.bid + 0.01;
    }
    let controlledUnderwaterExit = false;
    if (ask !== undefined && averageCost !== undefined) {
      const minimumProfitableAsk = averageCost + config.spreadExitEdgeCents / 100;
      if (ask < minimumProfitableAsk) {
        if (!config.underwaterExitEnabled) continue;
        if ((positionAgeSeconds ?? 0) < config.underwaterExitMinAgeHours * 3600) continue;
        // Once a position is stale, allow a deeper loss floor so the resting
        // ask can sit close enough to the market to actually clear, instead of
        // being pinned just below cost where it never fills.
        const isStale = (positionAgeSeconds ?? 0) >= config.staleInventoryAgeHours * 3600;
        const lossCapCents = isStale
          ? config.staleInventoryMaxLossCents
          : config.underwaterExitMaxLossCents;
        const maxLossAsk = Math.max(0.000001, averageCost - lossCapCents / 100);
        ask = Math.max(ask, maxLossAsk);
        controlledUnderwaterExit = ask < minimumProfitableAsk;
      }
    }
    if (ask !== undefined && ask > 0 && ask < 1) {
      // Inventory exits use a dedicated notional ceiling (and optional full-position
      // sizing). They must not inherit spread-entry order sizes — those are for new
      // risk, while exits are clearing existing risk.
      const inventoryNotionalCap = Math.max(0, config.inventoryExitMaxNotionalUsd);
      let exitNotionalUsd: number | undefined =
        inventoryNotionalCap > 0
          ? config.inventoryExitFullPosition
            ? Math.min(ask * roundShares(inventory), inventoryNotionalCap)
            : Math.min(config.spreadTargetOrderSizeUsd, inventoryNotionalCap)
          : undefined;
      if (controlledUnderwaterExit) {
        // Underwater exits still honour the dedicated unwind ceiling, but never
        // fall back to the tiny legacy underwater notional drip.
        const underwaterCap = Math.max(config.underwaterExitMaxNotionalUsd, inventoryNotionalCap);
        exitNotionalUsd = Math.min(exitNotionalUsd ?? underwaterCap, underwaterCap);
      }
      const sized =
        exitNotionalUsd === undefined || exitNotionalUsd <= 0
          ? undefined
          : quoteSize(ask, exitNotionalUsd);
      if (sized) {
        const sizeShares = Math.min(sized.sizeShares, roundShares(inventory));
        if (sizeShares > 0) {
          if (
            controlledUnderwaterExit &&
            averageCost !== undefined &&
            !config.inventoryExitFullPosition
          ) {
            const marketLossUsed = existingControlledMarketLossUsd(state, market.marketAppId);
            const quoteLoss = expectedLossUsd(averageCost, ask, sizeShares);
            if (marketLossUsed + quoteLoss > config.underwaterExitMaxMarketLossUsd) continue;
          }
          const rewardEligible =
            market.reward.isRewardMarket &&
            rewardSpread !== undefined &&
            Math.abs(midpoint - ask) <= rewardSpread;
          quotes.push({
            id: `${market.marketAppId}:${outcome}:ask:${Date.now()}`,
            marketId: market.id,
            marketAppId: market.marketAppId,
            slug: market.slug,
            title: market.title,
            outcome,
            side: "ask",
            price: ask,
            sizeShares,
            notionalUsd: ask * sizeShares,
            reason:
              controlledUnderwaterExit && averageCost !== undefined
                ? `${CONTROLLED_UNDERWATER_EXIT_REASON}; age=${((positionAgeSeconds ?? 0) / 3600).toFixed(1)}h loss=${(
                    (averageCost - ask) * 100
                  ).toFixed(2)}c`
                : "inventory exit ask",
            rewardEligible,
            rewardZoneDistanceCents:
              rewardSpread !== undefined ? Math.abs(midpoint - ask) * 100 : undefined,
            rewardMinContracts,
            estimatedRewardUsdPerDay: market.reward.dailyRewardsUsd,
            source: "inventory_exit",
          });
        }
      }
    }
  }
  return quotes;
}
