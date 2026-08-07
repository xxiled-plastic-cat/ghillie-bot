import type { AlphaConfig, AlphaMode } from "./alphaConfig.js";
import { validateLiveConfig } from "./alphaConfig.js";
import { AlphaSdkClient, fromMicroUnits, roundShares } from "./alphaClient.js";
import { checkQuoteRisk, getInventoryNotionalUsd } from "./alphaRiskManager.js";
import { loadAlphaState, saveAlphaState } from "./alphaStateStore.js";
import type { AlphaBotState, AlphaMarket, AlphaOrderbook, AlphaOutcome, AlphaPaperOrder, AlphaPaperPosition, AlphaQuote } from "./alphaTypes.js";
import type { AlphaScanResult } from "./alphaMarketScanner.js";
import { generateQuotes, rewardLaneAllowsMarket } from "./quoteEngine.js";
import { runParityLane } from "./parityTrader.js";
import { runInventoryMergeLane } from "./inventoryMerger.js";
import { runResolvedClaimLane } from "./resolvedClaimLane.js";
import { updateUnrealisedPnl } from "./pnlTracker.js";
import { accrueEstimatedRewards } from "./rewardTracker.js";
import { buildCapitalLedger, mergeCapitalLedgerIntoState } from "./capitalLedger.js";
import {
  applyLiveFillEvents,
  buildPlaceTimeFillEvent,
  classifyClosedOrdersAgainstInventory,
  detectFillDeltasFromWallet,
  inventorySideKey,
} from "./liveFillLedger.js";
import {
  buildInventorySnapshot,
  escrowedSellSharesFor,
  getPosition,
  inventoryInvariantMismatches,
  migratePositionsToAppIdKeys,
  syncPositionsFromInventory,
  INVENTORY_SHARE_EPSILON,
} from "./inventoryView.js";
import type { OpenOrder, WalletPosition } from "@alpha-arcade/sdk";
import { createAmarokRuntime } from "../integrations/amarok/runtime.js";
import { parseExecutionQuotePayload, signAndSubmitUnsignedGroup } from "../integrations/algorand/submitUnsigned.js";
import { isDebugModeEnabled } from "../utils/debugMode.js";
import { runPlanReview } from "./planReview/index.js";

const CONTROLLED_UNDERWATER_EXIT_REASON = "controlled underwater exit";

function fmtMemoryMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function logLiveMemory(phase: string, details: Record<string, number | string | boolean | undefined> = {}): void {
  if (!isDebugModeEnabled()) return;
  const memory = process.memoryUsage();
  const detailText = Object.entries(details)
    .filter((entry): entry is [string, number | string | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.log(
    `[startup-debug ${new Date().toISOString()}] [live-memory] phase="${phase}" rss_mb=${fmtMemoryMb(
      memory.rss,
    )} heap_used_mb=${fmtMemoryMb(memory.heapUsed)} heap_total_mb=${fmtMemoryMb(memory.heapTotal)} external_mb=${fmtMemoryMb(
      memory.external,
    )} array_buffers_mb=${fmtMemoryMb(memory.arrayBuffers)}${detailText ? ` ${detailText}` : ""}`,
  );
}

export type LiveAction = {
  kind: "place" | "cancel" | "skip" | "parity" | "merge" | "claim";
  message: string;
};

export type LiveTickResult = {
  actions: LiveAction[];
  state: AlphaBotState;
  walletUsdcBalanceUsd?: number;
  walletAlgoBalance?: number;
};

function toTrackedLiveOrder(
  quote: AlphaQuote,
  result: { escrowAppId: number; txIds: string[]; matchedQuantity?: number },
): AlphaPaperOrder {
  const now = new Date().toISOString();
  const matchedShares = result.matchedQuantity ?? 0;
  const filledShares = Math.max(0, matchedShares);
  const remainingShares = Math.max(0, quote.sizeShares - filledShares);
  return {
    ...quote,
    id: `live:${result.escrowAppId}`,
    runMode: "live",
    createdAt: now,
    updatedAt: now,
    status: remainingShares > 1e-9 ? "open" : "filled",
    reservedUsd: quote.side === "bid" ? quote.price * remainingShares : 0,
    filledShares,
    remainingShares,
    liveEscrowAppId: result.escrowAppId,
    liveTxIds: result.txIds,
  };
}

function toTrackedOpenOrder(order: OpenOrder, market: AlphaMarket | undefined): AlphaPaperOrder {
  const now = new Date().toISOString();
  const price = fromMicroUnits(order.price) ?? 0;
  const quantity = fromMicroUnits(order.quantity) ?? 0;
  const filledShares = fromMicroUnits(order.quantityFilled) ?? 0;
  const remainingShares = Math.max(0, quantity - filledShares);
  const side = order.side === 1 ? "bid" : "ask";
  return {
    id: `live:${order.escrowAppId}`,
    runMode: "live",
    marketId: market?.id ?? String(order.marketAppId),
    marketAppId: order.marketAppId,
    slug: market?.slug,
    title: market?.title ?? `market ${order.marketAppId}`,
    outcome: order.position === 1 ? "YES" : "NO",
    side,
    price,
    sizeShares: quantity,
    notionalUsd: side === "bid" ? price * remainingShares : 0,
    reason: "reconciled from live wallet open orders",
    rewardEligible: false,
    source: "spread",
    createdAt: now,
    updatedAt: now,
    status: "open",
    reservedUsd: side === "bid" ? price * remainingShares : 0,
    filledShares,
    remainingShares,
    liveEscrowAppId: order.escrowAppId,
    owner: order.owner,
  };
}

function quoteKey(value: Pick<AlphaQuote, "marketAppId" | "outcome" | "side" | "source">): string {
  return `${value.marketAppId}:${value.outcome}:${value.side}:${value.source}`;
}

function quoteDeltaCents(order: AlphaPaperOrder, quote: AlphaQuote): number {
  return Math.abs(order.price - quote.price) * 100;
}

function quoteSizeDeltaUsd(order: AlphaPaperOrder, quote: AlphaQuote): number {
  return Math.abs(order.price * order.remainingShares - quote.notionalUsd);
}

function isEquivalentQuote(order: AlphaPaperOrder, quote: AlphaQuote, config: AlphaConfig): boolean {
  if (quoteKey(order) !== quoteKey(quote)) return false;
  if (quoteDeltaCents(order, quote) > config.quoteRefreshThresholdCents) return false;
  const sizeToleranceUsd = Math.max(0.1, quote.notionalUsd * 0.1);
  return quoteSizeDeltaUsd(order, quote) <= sizeToleranceUsd;
}

function orderAgeSeconds(order: Pick<AlphaPaperOrder, "createdAt">): number {
  const created = Date.parse(order.createdAt);
  return Number.isFinite(created) ? Math.max(0, (Date.now() - created) / 1000) : 0;
}

function mergeLiveOrdersFromWallet(
  state: AlphaBotState,
  orders: OpenOrder[],
  marketByAppId: Map<number, AlphaMarket>,
): { synced: number; closedOrders: AlphaPaperOrder[] } {
  const previousLiveByEscrow = new Map(
    state.openOrders
      .filter((order) => order.runMode === "live" && order.liveEscrowAppId !== undefined)
      .map((order) => [order.liveEscrowAppId, order]),
  );
  const openLive = orders
    .filter((order) => order.quantity > order.quantityFilled)
    .map((order) => {
      const tracked = toTrackedOpenOrder(order, marketByAppId.get(order.marketAppId));
      const previous = previousLiveByEscrow.get(order.escrowAppId);
      if (!previous) return tracked;
      return {
        ...previous,
        ...tracked,
        rewardEligible: previous.rewardEligible,
        rewardZoneDistanceCents: previous.rewardZoneDistanceCents,
        rewardMinContracts: previous.rewardMinContracts,
        estimatedRewardUsdPerDay: previous.estimatedRewardUsdPerDay,
        source: previous.source,
        reason: previous.reason,
        createdAt: previous.createdAt,
        liveTxIds: previous.liveTxIds,
      };
    });

  const liveEscrows = new Set(openLive.map((order) => order.liveEscrowAppId));
  const closedOrders: AlphaPaperOrder[] = [];
  for (const previous of previousLiveByEscrow.values()) {
    if (previous.liveEscrowAppId !== undefined && !liveEscrows.has(previous.liveEscrowAppId)) {
      closedOrders.push(previous);
    }
  }
  state.openOrders = [...state.openOrders.filter((order) => order.runMode !== "live"), ...openLive];
  return { synced: openLive.length, closedOrders };
}

function positionShareCount(position: { yesShares: number; noShares: number }, outcome: AlphaOutcome): number {
  return outcome === "YES" ? position.yesShares : position.noShares;
}

function fmtSignedUsd(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(4)}`;
}

function getOutcomeBook(book: AlphaOrderbook, outcome: AlphaOutcome): { bid?: number; ask?: number; mid?: number; spread?: number } {
  return outcome === "YES"
    ? { bid: book.yesBid, ask: book.yesAsk, mid: book.yesMid, spread: book.yesSpread }
    : { bid: book.noBid, ask: book.noAsk, mid: book.noMid, spread: book.noSpread };
}

function bestExternalDepthUsd(levels: Array<{ price: number; quantityShares: number; owner?: string }>, walletAddress?: string): number {
  const level = levels.find((candidate) => candidate.owner === undefined || candidate.owner !== walletAddress);
  return level ? level.price * level.quantityShares : 0;
}

function outcomeDepthUsd(book: AlphaOrderbook, outcome: AlphaOutcome, walletAddress?: string): number {
  const orders = outcome === "YES" ? book.yesSideOrders : book.noSideOrders;
  return Math.min(bestExternalDepthUsd(orders.bids, walletAddress), bestExternalDepthUsd(orders.asks, walletAddress));
}

function outcomeIsTwoSided(book: AlphaOrderbook, outcome: AlphaOutcome, walletAddress?: string): boolean {
  const outcomeBook = getOutcomeBook(book, outcome);
  return (
    outcomeBook.bid !== undefined &&
    outcomeBook.ask !== undefined &&
    outcomeBook.mid !== undefined &&
    outcomeBook.spread !== undefined &&
    outcomeDepthUsd(book, outcome, walletAddress) > 0
  );
}

function updateSpreadMarketStats(
  state: AlphaBotState,
  scan: AlphaScanResult,
  marketByAppId: Map<number, AlphaMarket>,
  config: AlphaConfig,
): number {
  const now = new Date().toISOString();
  let updated = 0;
  for (const [marketAppId, book] of scan.orderbooks) {
    const market = marketByAppId.get(marketAppId);
    if (!market) continue;
    const outcomes = (["YES", "NO"] as const)
      .map((outcome) => {
        const outcomeBook = getOutcomeBook(book, outcome);
        return {
          outcome,
          twoSided: outcomeIsTwoSided(book, outcome, config.walletAddress),
          depthUsd: outcomeDepthUsd(book, outcome, config.walletAddress),
          spreadCents: outcomeBook.spread !== undefined ? outcomeBook.spread * 100 : undefined,
        };
      })
      .filter((outcome) => outcome.twoSided);
    const best = outcomes.sort((a, b) => b.depthUsd - a.depthUsd)[0];
    const key = String(marketAppId);
    const previous = state.spreadStatsByMarket[key];
    const twoSided = best !== undefined;
    state.spreadStatsByMarket[key] = {
      marketId: market.id,
      marketAppId,
      title: market.title,
      volume: market.volume,
      observedScans: (previous?.observedScans ?? 0) + 1,
      consecutiveTwoSidedScans: twoSided ? (previous?.consecutiveTwoSidedScans ?? 0) + 1 : 0,
      bestDepthUsd: best?.depthUsd,
      bestSpreadCents: best?.spreadCents,
      lastTwoSidedAt: twoSided ? now : previous?.lastTwoSidedAt,
      lastSeenAt: now,
    };
    updated += 1;
  }
  return updated;
}

function spreadEntryRejection(quote: AlphaQuote, state: AlphaBotState, config: AlphaConfig): string | undefined {
  if (quote.source !== "spread" || quote.side !== "bid") return undefined;
  const stats = state.spreadStatsByMarket[String(quote.marketAppId)];
  if (!stats) return "spread market has not been observed yet";
  if ((stats.volume ?? 0) < config.minSpreadVolumeUsd) {
    return `volume ${(stats.volume ?? 0).toFixed(2)} below spread minimum ${config.minSpreadVolumeUsd.toFixed(2)}`;
  }
  if (stats.consecutiveTwoSidedScans < config.spreadPersistenceScans) {
    return `two-sided book only persisted ${stats.consecutiveTwoSidedScans}/${config.spreadPersistenceScans} scan(s)`;
  }
  if ((stats.bestDepthUsd ?? 0) < config.minSpreadDepthUsd) {
    return `visible same-outcome depth $${(stats.bestDepthUsd ?? 0).toFixed(2)} below minimum $${config.minSpreadDepthUsd.toFixed(2)}`;
  }
  if ((stats.bestSpreadCents ?? 0) < config.minSpreadCaptureCents) {
    return `spread ${(stats.bestSpreadCents ?? 0).toFixed(2)}c below minimum ${config.minSpreadCaptureCents.toFixed(2)}c`;
  }
  return undefined;
}

function spreadQuoteQuality(quote: AlphaQuote, state: AlphaBotState): number {
  const stats = state.spreadStatsByMarket[String(quote.marketAppId)];
  if (!stats) return 0;
  return Math.log10((stats.volume ?? 0) + 1) * 10 + (stats.bestDepthUsd ?? 0) + (stats.bestSpreadCents ?? 0);
}

function shouldTrackSpreadStats(config: AlphaConfig): boolean {
  return config.enableSpreadLane && config.enableSpreadCapture;
}

function pruneSpreadStatsToActiveMarkets(
  state: AlphaBotState,
  activeMarketAppIds: Set<number>,
): { pruned: number; retained: number } {
  let pruned = 0;
  let retained = 0;
  for (const marketAppId of Object.keys(state.spreadStatsByMarket)) {
    if (activeMarketAppIds.has(Number(marketAppId))) {
      retained += 1;
      continue;
    }
    delete state.spreadStatsByMarket[marketAppId];
    pruned += 1;
  }
  return { pruned, retained };
}

function findMarketForPosition(
  position: AlphaBotState["positionsByMarket"][string],
  marketByAppId: Map<number, AlphaMarket>,
): AlphaMarket | undefined {
  if (position.marketAppId !== undefined) return marketByAppId.get(position.marketAppId);
  return [...marketByAppId.values()].find((market) => market.id === position.marketId);
}

function trackedOutcomeAgeSeconds(state: AlphaBotState, marketAppId: number, outcome: AlphaOutcome, now = Date.now()): number | undefined {
  const timestamps: number[] = [];
  for (const order of state.openOrders) {
    if (order.runMode !== "live" || order.marketAppId !== marketAppId || order.outcome !== outcome || order.side !== "bid") continue;
    const created = Date.parse(order.createdAt);
    if (Number.isFinite(created)) timestamps.push(created);
  }
  for (const fill of state.fills) {
    if (fill.runMode !== "live" || fill.marketAppId !== marketAppId || fill.outcome !== outcome || fill.side !== "bid") continue;
    const when = Date.parse(fill.updatedAt ?? fill.createdAt);
    if (Number.isFinite(when)) timestamps.push(when);
  }
  if (timestamps.length === 0) return undefined;
  return Math.max(0, (now - Math.min(...timestamps)) / 1000);
}

function expectedLossUsd(averageCost: number, ask: number, shares: number): number {
  return Math.max(0, (averageCost - ask) * shares);
}

function controlledUnderwaterMarketLossUsd(state: AlphaBotState, marketAppId: number, ignoreEscrowAppId?: number): number {
  return state.openOrders
    .filter(
      (order) =>
        order.runMode === "live" &&
        order.status === "open" &&
        order.marketAppId === marketAppId &&
        order.source === "inventory_exit" &&
        order.side === "ask" &&
        order.reason.startsWith(CONTROLLED_UNDERWATER_EXIT_REASON) &&
        order.liveEscrowAppId !== ignoreEscrowAppId,
    )
    .reduce((sum, order) => {
      const position = getPosition(state, order.marketAppId);
      const averageCost = order.outcome === "YES" ? position?.avgYesCost : position?.avgNoCost;
      if (averageCost === undefined || averageCost <= 0) return sum;
      return sum + expectedLossUsd(averageCost, order.price, order.remainingShares);
    }, 0);
}

function controlledUnderwaterExitStatus(
  state: AlphaBotState,
  marketAppId: number,
  outcome: AlphaOutcome,
  ask: number,
  shares: number,
  config: AlphaConfig,
  ignoreEscrowAppId?: number,
): { allowed: boolean; reason: string } {
  const position = getPosition(state, marketAppId);
  const averageCost = outcome === "YES" ? position?.avgYesCost : position?.avgNoCost;
  if (averageCost === undefined || averageCost <= 0) return { allowed: false, reason: "tracked cost basis unavailable" };
  if (!config.underwaterExitEnabled) return { allowed: false, reason: "underwater exits disabled" };
  const ageSeconds = trackedOutcomeAgeSeconds(state, marketAppId, outcome);
  if ((ageSeconds ?? 0) < config.underwaterExitMinAgeHours * 3600) {
    return {
      allowed: false,
      reason: `underwater grace period ${((ageSeconds ?? 0) / 3600).toFixed(1)}/${config.underwaterExitMinAgeHours.toFixed(1)}h`,
    };
  }
  const lossCents = Math.max(0, (averageCost - ask) * 100);
  // Stale positions get a market-clearing tier: bypass the normal per-quote
  // loss/notional/market-loss caps and only enforce the wider stale loss cap.
  const isStale = (ageSeconds ?? 0) >= config.staleInventoryAgeHours * 3600;
  if (isStale) {
    if (lossCents > config.staleInventoryMaxLossCents) {
      return {
        allowed: false,
        reason: `stale loss ${lossCents.toFixed(2)}c exceeds stale cap ${config.staleInventoryMaxLossCents.toFixed(2)}c`,
      };
    }
    return {
      allowed: true,
      reason: `stale inventory liquidation; age=${((ageSeconds ?? 0) / 3600).toFixed(1)}h loss ${lossCents.toFixed(2)}c`,
    };
  }
  if (lossCents > config.underwaterExitMaxLossCents) {
    return { allowed: false, reason: `loss ${lossCents.toFixed(2)}c exceeds cap ${config.underwaterExitMaxLossCents.toFixed(2)}c` };
  }
  const notional = ask * shares;
  const notionalCap = Math.max(config.underwaterExitMaxNotionalUsd, config.inventoryExitMaxNotionalUsd);
  if (notional > notionalCap + 1e-9) {
    return { allowed: false, reason: `notional $${notional.toFixed(2)} exceeds unwind cap $${notionalCap.toFixed(2)}` };
  }
  if (!config.inventoryExitFullPosition) {
    const marketLossUsed = controlledUnderwaterMarketLossUsd(state, marketAppId, ignoreEscrowAppId);
    const projectedLoss = expectedLossUsd(averageCost, ask, shares);
    if (marketLossUsed + projectedLoss > config.underwaterExitMaxMarketLossUsd) {
      return {
        allowed: false,
        reason: `market loss cap $${config.underwaterExitMaxMarketLossUsd.toFixed(2)} would be exceeded`,
      };
    }
  }
  return { allowed: true, reason: `controlled underwater exit eligible; loss ${lossCents.toFixed(2)}c` };
}

function describeMissingExit(
  state: AlphaBotState,
  position: AlphaBotState["positionsByMarket"][string],
  outcome: AlphaOutcome,
  market: AlphaMarket | undefined,
  book: AlphaOrderbook | undefined,
  config: AlphaConfig,
): string {
  if (!market) return "market metadata was not in this scan";
  if (!book) return "orderbook was not scanned for this market";
  const outcomeBook = getOutcomeBook(book, outcome);
  if (outcomeBook.mid === undefined) return "same-outcome midpoint unavailable";
  const averageCost = outcome === "YES" ? position.avgYesCost : position.avgNoCost;
  const minimumProfitableAsk = averageCost > 0 ? averageCost + config.spreadExitEdgeCents / 100 : undefined;
  const shares = positionShareCount(position, outcome);
  const costFloorReason = (ask: number) =>
    minimumProfitableAsk !== undefined && ask < minimumProfitableAsk
      ? (() => {
          if (position.marketAppId === undefined) {
            return `target ask ${ask.toFixed(3)} below cost floor ${minimumProfitableAsk.toFixed(3)} (avg ${averageCost.toFixed(3)} + ${config.spreadExitEdgeCents.toFixed(
              2,
            )}c); tracked cost basis available but marketAppId missing`;
          }
          const status = controlledUnderwaterExitStatus(state, position.marketAppId, outcome, ask, shares, config);
          return `target ask ${ask.toFixed(3)} below cost floor ${minimumProfitableAsk.toFixed(3)} (avg ${averageCost.toFixed(3)} + ${config.spreadExitEdgeCents.toFixed(
            2,
          )}c); ${status.reason}`;
        })()
      : undefined;
  const spreadMidpointAllowed = outcomeBook.mid >= config.minSpreadExitMidpoint && outcomeBook.mid <= config.maxSpreadMidpoint;
  const rewardMidpointAllowed = outcomeBook.mid >= config.minMidpoint && outcomeBook.mid <= config.maxMidpoint;
  if (market.reward.isRewardMarket && market.reward.maxRewardSpreadCents !== undefined && rewardMidpointAllowed) {
    const rewardAsk = outcomeBook.mid + config.rewardZoneBufferCents / 100;
    if (rewardAsk <= 0 || rewardAsk >= 1) return `reward-zone ask ${rewardAsk.toFixed(3)} outside valid price range`;
    const costReason = costFloorReason(rewardAsk);
    if (costReason) return costReason;
    return "reward-zone exit looked possible but no quote was produced";
  }
  if (!spreadMidpointAllowed) {
    return `midpoint ${outcomeBook.mid.toFixed(3)} outside spread exit bounds ${config.minSpreadExitMidpoint.toFixed(3)}-${config.maxSpreadMidpoint.toFixed(3)}`;
  }
  if (outcomeBook.bid === undefined) {
    return `missing same-outcome bid side; ask=${outcomeBook.ask?.toFixed(3) ?? "n/a"}, spread=${
      outcomeBook.spread !== undefined ? `${(outcomeBook.spread * 100).toFixed(2)}c` : "n/a"
    }`;
  }
  const edge =
    outcomeBook.spread !== undefined
      ? Math.min(config.spreadExitEdgeCents / 100, outcomeBook.spread / 4)
      : config.spreadExitEdgeCents / 100;
  const ask = Math.max(outcomeBook.mid + edge, outcomeBook.bid + 0.000001);
  const costReason = costFloorReason(ask);
  if (costReason) return costReason;
  if (outcomeBook.ask !== undefined && (ask <= outcomeBook.bid || ask >= outcomeBook.ask)) {
    return `no room for exit ask inside spread: bid ${outcomeBook.bid.toFixed(3)}, ask ${outcomeBook.ask.toFixed(3)}, target ${ask.toFixed(3)}`;
  }
  return `exit looked possible for ${shares.toFixed(6)} share(s) but no quote was produced`;
}

function rewardOrderInsideCurrentZone(
  order: AlphaPaperOrder,
  market: AlphaMarket | undefined,
  book: AlphaOrderbook | undefined,
): boolean {
  if (!order.rewardEligible) return false;
  if (!market?.reward.isRewardMarket) return false;
  if (market.reward.maxRewardSpreadCents === undefined) return false;
  if (!book || book.source === "unavailable") return false;
  const midpoint = order.outcome === "YES" ? book.yesMid : book.noMid;
  if (midpoint === undefined) return false;
  const distanceCents = Math.abs(midpoint - order.price) * 100;
  return distanceCents <= market.reward.maxRewardSpreadCents;
}

function rewardContractsByMarket(state: AlphaBotState): Map<number, number> {
  const contracts = new Map<number, number>();
  for (const order of state.openOrders) {
    if (order.runMode !== "live" || order.status !== "open" || !order.rewardEligible) continue;
    addRewardContracts(contracts, order.marketAppId, order.remainingShares);
  }
  return contracts;
}

function quoteRewardContracts(quote: AlphaQuote): number {
  return quote.rewardEligible ? quote.sizeShares : 0;
}

function addRewardContracts(contractsByMarket: Map<number, number>, marketAppId: number, contracts: number): void {
  if (contracts === 0) return;
  contractsByMarket.set(marketAppId, Math.max(0, (contractsByMarket.get(marketAppId) ?? 0) + contracts));
}

function queuedRewardContractsByMarket(quotes: AlphaQuote[]): Map<number, number> {
  const contracts = new Map<number, number>();
  for (const quote of quotes) {
    addRewardContracts(contracts, quote.marketAppId, quoteRewardContracts(quote));
  }
  return contracts;
}

function replacePendingRewardContracts(contractsByMarket: Map<number, number>, previous: AlphaQuote, next?: AlphaQuote): void {
  addRewardContracts(contractsByMarket, previous.marketAppId, -quoteRewardContracts(previous));
  if (next) addRewardContracts(contractsByMarket, next.marketAppId, quoteRewardContracts(next));
}

function rewardMinContractsForOrder(order: AlphaPaperOrder, market: AlphaMarket | undefined): number | undefined {
  const configuredMin = order.rewardMinContracts ?? market?.reward.minContracts;
  return configuredMin === undefined || configuredMin <= 0 ? undefined : configuredMin;
}

function decrementRewardContracts(contractsByMarket: Map<number, number>, order: AlphaPaperOrder): void {
  if (!order.rewardEligible) return;
  addRewardContracts(contractsByMarket, order.marketAppId, -order.remainingShares);
}

function quoteMinNotionalUsd(quote: AlphaQuote, config: AlphaConfig): number {
  if (quote.source === "reward") return Math.max(0, config.rewardMinOrderSizeUsd);
  if (quote.source === "spread") return Math.max(0, config.spreadMinOrderSizeUsd);
  return 0;
}

function resizeBidQuoteToBudget(
  quote: AlphaQuote,
  remainingLiveBidUsdc: number,
  config: AlphaConfig,
): { quote?: AlphaQuote; reason?: string; resized: boolean } {
  const requiredUsdc = requiredBidUsdc(quote, config);
  if (requiredUsdc <= remainingLiveBidUsdc) return { quote, resized: false };
  const budgetMultiplier = 1 + config.liveBidUsdcBufferBps / 10_000;
  if (budgetMultiplier <= 0) return { reason: "invalid live bid buffer configuration", resized: false };
  const maxNotionalUsd = remainingLiveBidUsdc / budgetMultiplier;
  const minNotionalUsd = quoteMinNotionalUsd(quote, config);
  if (maxNotionalUsd < minNotionalUsd) {
    return {
      reason: `wallet USDC ${remainingLiveBidUsdc.toFixed(2)} only funds up to $${maxNotionalUsd.toFixed(
        2,
      )} after buffer, below lane minimum $${minNotionalUsd.toFixed(2)}`,
      resized: false,
    };
  }
  const sizeShares = roundShares(maxNotionalUsd / quote.price);
  if (sizeShares <= 0) {
    return {
      reason: `wallet USDC ${remainingLiveBidUsdc.toFixed(2)} cannot fund minimum share precision at ${quote.price.toFixed(3)}`,
      resized: false,
    };
  }
  const notionalUsd = quote.price * sizeShares;
  if (notionalUsd + 0.000001 < minNotionalUsd) {
    return {
      reason: `resized notional $${notionalUsd.toFixed(2)} falls below lane minimum $${minNotionalUsd.toFixed(2)}`,
      resized: false,
    };
  }
  const resizedQuote: AlphaQuote = {
    ...quote,
    sizeShares,
    notionalUsd,
  };
  if (requiredBidUsdc(resizedQuote, config) > remainingLiveBidUsdc + 0.000001) {
    return {
      reason: `wallet USDC ${remainingLiveBidUsdc.toFixed(2)} remains below buffered resized requirement`,
      resized: false,
    };
  }
  return { quote: resizedQuote, resized: true };
}

function exitOrderWouldLoseMoney(order: AlphaPaperOrder, state: AlphaBotState, config: AlphaConfig): boolean {
  if (order.source !== "inventory_exit" || order.side !== "ask") return false;
  const position = getPosition(state, order.marketAppId);
  const averageCost = order.outcome === "YES" ? position?.avgYesCost : position?.avgNoCost;
  if (averageCost === undefined || averageCost <= 0) return false;
  return order.price < averageCost + config.spreadExitEdgeCents / 100;
}

function controlledUnderwaterExitAllowed(order: AlphaPaperOrder, state: AlphaBotState, config: AlphaConfig): boolean {
  if (order.source !== "inventory_exit" || order.side !== "ask") return false;
  const status = controlledUnderwaterExitStatus(
    state,
    order.marketAppId,
    order.outcome,
    order.price,
    order.remainingShares,
    config,
    order.liveEscrowAppId,
  );
  return status.allowed;
}

const SHARE_EPSILON = INVENTORY_SHARE_EPSILON;

// Consecutive ticks a position must stay unaccounted (absent from wallet free
// balance AND open sell-order escrow) before it is reconciled and pruned.
// Guards against transient wallet/API read gaps; always on.
const STALE_POSITION_PRUNE_TICKS = 10;

// How often the live tick re-scans the chain for actual LP reward receipts so
// the digest's "received" figure stays current without scanning every tick.
const ACTUAL_REWARD_REFRESH_MS = 3_600_000;

/**
 * Throttled refresh of the actual on-chain LP rewards received (the real number
 * shown in the digest), persisted into `state.capitalLedger` only. Never mutates
 * trading positions, fill history, or realised/unrealised PnL. Defensive: a
 * scan failure never affects trading. Only runs in live mode (dry-run keeps
 * the last value).
 */
async function refreshActualRewardsReceived(input: {
  config: AlphaConfig;
  mode: Extract<AlphaMode, "live-dry-run" | "live">;
  state: AlphaBotState;
  marketAppIds: number[];
  walletOrders: OpenOrder[];
  actions: LiveAction[];
}): Promise<void> {
  const { config, mode, state, marketAppIds, walletOrders, actions } = input;
  if (mode !== "live" || !config.walletAddress) return;
  if (!config.actualRewardRefreshInLive) return;
  const lastScan = state.capitalLedger?.lastScanAt ? Date.parse(state.capitalLedger.lastScanAt) : 0;
  const fresh = Number.isFinite(lastScan) && Date.now() - lastScan < ACTUAL_REWARD_REFRESH_MS;
  if (fresh) return;
  try {
    const escrowAppIds = [
      ...state.openOrders.filter((order) => order.liveEscrowAppId !== undefined).map((order) => order.liveEscrowAppId as number),
      ...walletOrders.map((order) => order.escrowAppId),
    ];
    const ledger = await buildCapitalLedger({
      config,
      walletAddress: config.walletAddress,
      bidEscrowUsd: 0,
      positions: [],
      state,
      marketAppIds,
      escrowAppIds,
      forceRefresh: true,
    });
    const merged = mergeCapitalLedgerIntoState(state, ledger.flows, ledger.scanMeta);
    state.capitalLedger = merged.capitalLedger;
    actions.push({
      kind: "skip",
      message: `Refreshed actual LP rewards received: $${ledger.flows.rewardsReceivedUsd.toFixed(6)}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    actions.push({ kind: "skip", message: `Actual reward receipt refresh skipped: ${message}` });
  }
}

/**
 * Account for unaccounted shares when:
 * - market is resolved with a known YES/NO outcome (auto-pay / burn), or
 * - shares stayed absent from wallet+escrow for the prune window (filled /
 *   settled outside the fill ledger). Sustained absence never invents a mark
 *   write-off; voided / unknown resolutions may prune without PnL too.
 */
export function realiseStaleSide(
  position: AlphaPaperPosition,
  outcome: AlphaOutcome,
  shares: number,
  resolution: { isResolved?: boolean; outcome?: number },
  options?: { sustainedAbsence?: boolean },
): { realised: number; note: string; allowMutate: boolean; realisePnl: boolean } {
  const avgCost = outcome === "YES" ? position.avgYesCost ?? 0 : position.avgNoCost ?? 0;
  const cost = shares * avgCost;
  if (resolution.isResolved !== true) {
    if (options?.sustainedAbsence) {
      return {
        realised: 0,
        note: "sustained absence from wallet+escrow; pruning ghost inventory without mark write-off (likely filled outside fill ledger)",
        allowMutate: true,
        realisePnl: false,
      };
    }
    return {
      realised: 0,
      note: "not resolved on-chain; deferring PnL and prune (API gap / transient read)",
      allowMutate: false,
      realisePnl: false,
    };
  }
  if (resolution.outcome === 1 || resolution.outcome === 0) {
    const sideWon = (resolution.outcome === 1 && outcome === "YES") || (resolution.outcome === 0 && outcome === "NO");
    const proceeds = sideWon ? shares : 0;
    return {
      realised: proceeds - cost,
      note: `resolved ${describeResolutionOutcome(resolution.outcome)}; ${sideWon ? "WON" : "LOST"} → proceeds $${proceeds.toFixed(2)} (auto-paid to wallet), cost $${cost.toFixed(2)}`,
      allowMutate: true,
      realisePnl: true,
    };
  }
  return {
    realised: 0,
    note: `resolved voided/unknown (outcome=${resolution.outcome}); pruning unaccounted shares without mark write-off`,
    allowMutate: true,
    realisePnl: false,
  };
}

function describeResolutionOutcome(outcome: number | undefined): string {
  if (outcome === 1) return "YES won";
  if (outcome === 0) return "NO won";
  if (outcome !== undefined) return `outcome=${outcome}`;
  return "outcome unknown";
}

/**
 * Reconcile each bot-state position against the wallet's actual free ASA
 * balance plus shares escrowed in open SELL orders. Persistently unaccounted
 * sides mutate when the market is resolved, or after the prune window when
 * free+escrow stay at zero (ghost inventory). Mark write-offs are never
 * invented for unresolved gaps.
 */
async function reconcilePositions(input: {
  liveClient: AlphaSdkClient;
  config: AlphaConfig;
  mode: Extract<AlphaMode, "live-dry-run" | "live">;
  state: AlphaBotState;
  walletPositions: WalletPosition[];
  walletOrders: OpenOrder[];
  actions: LiveAction[];
}): Promise<void> {
  const { liveClient, config, mode, state, walletPositions, walletOrders, actions } = input;

  const migrated = migratePositionsToAppIdKeys(state);
  if (migrated > 0) {
    actions.push({ kind: "skip", message: `Position reconcile: migrated ${migrated} duplicate state key(s) onto marketAppId` });
  }

  const walletByAppId = new Map<number, WalletPosition>();
  for (const wallet of walletPositions) walletByAppId.set(wallet.marketAppId, wallet);

  const pruneTicks = STALE_POSITION_PRUNE_TICKS;

  for (const [key, position] of Object.entries(state.positionsByMarket)) {
    const appId = position.marketAppId;
    const wallet = appId !== undefined ? walletByAppId.get(appId) : undefined;
    const title = position.title || (appId !== undefined ? `market ${appId}` : key);

    const sideState: Record<AlphaOutcome, { stateShares: number; free: number; escrow: number; unaccounted: number }> = {
      YES: { stateShares: position.yesShares, free: 0, escrow: 0, unaccounted: 0 },
      NO: { stateShares: position.noShares, free: 0, escrow: 0, unaccounted: 0 },
    };
    for (const outcome of ["YES", "NO"] as const) {
      const free = (outcome === "YES" ? fromMicroUnits(wallet?.yesBalance) : fromMicroUnits(wallet?.noBalance)) ?? 0;
      const escrow = appId !== undefined ? escrowedSellSharesFor(walletOrders, appId, outcome) : 0;
      sideState[outcome].free = free;
      sideState[outcome].escrow = escrow;
      sideState[outcome].unaccounted = sideState[outcome].stateShares - (free + escrow);
      const { stateShares } = sideState[outcome];
      if (stateShares <= SHARE_EPSILON && free <= SHARE_EPSILON && escrow <= SHARE_EPSILON) continue;
      let verdict: string;
      const unaccounted = sideState[outcome].unaccounted;
      if (stateShares <= SHARE_EPSILON) {
        verdict = "wallet/escrow holds shares not tracked in bot state";
      } else if (Math.abs(unaccounted) <= SHARE_EPSILON) {
        verdict = escrow > SHARE_EPSILON ? "fully accounted (some escrowed in open sell orders)" : "fully accounted (free wallet balance)";
      } else if (unaccounted > 0) {
        verdict = `UNACCOUNTED ${unaccounted.toFixed(6)} share(s): not in wallet or open orders`;
      } else {
        verdict = `wallet+escrow exceeds state by ${Math.abs(unaccounted).toFixed(6)} share(s)`;
      }
      actions.push({
        kind: "skip",
        message: `Position reconcile: ${title} (appId=${appId ?? "?"}) ${outcome} state=${stateShares.toFixed(6)} free=${free.toFixed(
          6,
        )} escrow=${escrow.toFixed(6)} → ${verdict}`,
      });
    }

    const hasUnaccounted = sideState.YES.unaccounted > SHARE_EPSILON || sideState.NO.unaccounted > SHARE_EPSILON;
    if (!hasUnaccounted) {
      if ((position.unaccountedTicks ?? 0) !== 0) position.unaccountedTicks = 0;
      continue;
    }

    position.unaccountedTicks = (position.unaccountedTicks ?? 0) + 1;
    if (position.unaccountedTicks < pruneTicks) {
      actions.push({
        kind: "skip",
        message: `Position reconcile: ${title} (appId=${appId ?? "?"}) unaccounted ${position.unaccountedTicks}/${pruneTicks} tick(s) before reconcile`,
      });
      continue;
    }

    if (appId === undefined) continue;

    let resolution: { isResolved?: boolean; outcome?: number } = {};
    try {
      resolution = await liveClient.getMarketResolution(appId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      actions.push({
        kind: "skip",
        message: `Position reconcile: ${title} (appId=${appId}) resolution lookup failed, deferring prune: ${message}`,
      });
      continue;
    }

    let mutated = false;
    for (const outcome of ["YES", "NO"] as const) {
      const unaccounted = sideState[outcome].unaccounted;
      if (unaccounted <= SHARE_EPSILON) continue;
      const sustainedAbsence = resolution.isResolved !== true;
      const { realised, note, allowMutate, realisePnl } = realiseStaleSide(position, outcome, unaccounted, resolution, {
        sustainedAbsence,
      });
      const accounted = sideState[outcome].free + sideState[outcome].escrow;
      if (!allowMutate) {
        actions.push({
          kind: "skip",
          message: `Position reconcile: ${title} ${outcome} ${unaccounted.toFixed(6)} stale share(s): ${note}`,
        });
        continue;
      }
      if (mode === "live-dry-run") {
        actions.push({
          kind: "claim",
          message: `Would reconcile ${title} ${outcome} ${unaccounted.toFixed(6)} stale share(s): ${note}${
            realisePnl ? `; realised=${fmtSignedUsd(realised)}` : "; no PnL mutation"
          }`,
        });
        continue;
      }
      if (outcome === "YES") {
        position.yesShares = accounted;
        if (position.yesShares <= SHARE_EPSILON) position.avgYesCost = 0;
      } else {
        position.noShares = accounted;
        if (position.noShares <= SHARE_EPSILON) position.avgNoCost = 0;
      }
      if (realisePnl) {
        position.realisedPnl += realised;
        state.realisedPnl += realised;
      }
      mutated = true;
      actions.push({
        kind: "claim",
        message: `Reconciled ${title} ${outcome} ${unaccounted.toFixed(6)} stale share(s): ${note}${
          realisePnl ? `; realised=${fmtSignedUsd(realised)}` : "; no PnL mutation"
        }`,
      });
    }

    if (mode === "live" && mutated) {
      position.unaccountedTicks = 0;
      if (position.yesShares <= SHARE_EPSILON && position.noShares <= SHARE_EPSILON) {
        delete state.positionsByMarket[key];
        actions.push({ kind: "claim", message: `Position reconcile: pruned fully reconciled position ${title} (appId=${appId})` });
      }
      await saveAlphaState(config.stateKey, state);
    }
  }
}

function addInventoryExitDiagnostics(
  actions: LiveAction[],
  state: AlphaBotState,
  quotes: AlphaQuote[],
  scan: AlphaScanResult,
  marketByAppId: Map<number, AlphaMarket>,
  config: AlphaConfig,
): void {
  const positions = Object.values(state.positionsByMarket).filter((position) => position.yesShares > 0 || position.noShares > 0);
  if (positions.length === 0) {
    actions.push({ kind: "skip", message: "Inventory audit: no held YES/NO shares in bot state" });
    return;
  }

  for (const position of positions) {
    const market = findMarketForPosition(position, marketByAppId);
    const marketAppId = position.marketAppId ?? market?.marketAppId;
    const book = marketAppId !== undefined ? scan.orderbooks.get(marketAppId) : undefined;
    actions.push({
      kind: "skip",
      message: `Inventory audit: ${position.title} YES=${position.yesShares.toFixed(6)} NO=${position.noShares.toFixed(6)}`,
    });
    for (const outcome of ["YES", "NO"] as const) {
      const shares = positionShareCount(position, outcome);
      if (shares <= 0) continue;
      const exit = quotes.find((quote) => quote.source === "inventory_exit" && quote.marketId === position.marketId && quote.outcome === outcome);
      if (exit) {
        actions.push({
          kind: "skip",
          message: `Exit audit: planned ${position.title} ${outcome} ask ${exit.price.toFixed(3)} for ${exit.sizeShares.toFixed(6)} share(s); ${exit.reason}`,
        });
        continue;
      }
      actions.push({
        kind: "skip",
        message: `Exit audit: no ${position.title} ${outcome} exit for ${shares.toFixed(6)} share(s): ${describeMissingExit(
          state,
          position,
          outcome,
          market,
          book,
          config,
        )}`,
      });
    }
  }
}

async function loadWalletOpenOrders(
  liveClient: AlphaSdkClient,
  walletAddress: string,
  marketByAppId: Map<number, AlphaMarket>,
): Promise<OpenOrder[]> {
  try {
    return await liveClient.getWalletOpenOrders(walletAddress);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ghillie-live] wallet order sync via API failed; falling back to per-market reads: ${message}`);
    const results = await Promise.allSettled(
      [...marketByAppId.keys()].map((marketAppId) => liveClient.getOpenOrders(marketAppId, walletAddress)),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(
          `[ghillie-live] per-market open order read failed: ${
            failure.status === "rejected" ? (failure.reason instanceof Error ? failure.reason.message : String(failure.reason)) : "unknown"
          }`,
        );
      }
    }
    const fulfilled = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    if (fulfilled.length === 0 && failures.length > 0) {
      throw new Error("Unable to read wallet open orders from API and all per-market fallbacks failed");
    }
    return fulfilled;
  }
}

async function finalLiveTickResult(
  liveClient: AlphaSdkClient,
  config: AlphaConfig,
  actions: LiveAction[],
  state: AlphaBotState,
  options: {
    walletUsdcBalanceUsd?: number;
    walletAlgoBalance?: number;
    refreshBalances?: boolean;
  } = {},
): Promise<LiveTickResult> {
  let walletUsdcBalanceUsd = options.walletUsdcBalanceUsd;
  let walletAlgoBalance = options.walletAlgoBalance;
  const refreshBalances = options.refreshBalances ?? true;
  if (refreshBalances && config.walletAddress) {
    try {
      walletUsdcBalanceUsd = await liveClient.getUsdcBalance(config.walletAddress);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ghillie-live] ${message}`);
      actions.push({ kind: "skip", message: `Wallet USDC refresh failed: ${message}` });
    }
    try {
      walletAlgoBalance = await liveClient.getAlgoBalance(config.walletAddress);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ghillie-live] ${message}`);
      actions.push({ kind: "skip", message: `Wallet ALGO refresh failed: ${message}` });
    }
    actions.push({ kind: "skip", message: "Refreshed wallet USDC/ALGO balances for live summary" });
  }
  return { actions, state, walletUsdcBalanceUsd, walletAlgoBalance };
}

type LaneQueues = {
  reward: AlphaQuote[];
  spread: AlphaQuote[];
  exits: AlphaQuote[];
};

function buildLaneQueues(quotes: AlphaQuote[], state: AlphaBotState, config: AlphaConfig): LaneQueues {
  const deduped = new Map<string, AlphaQuote>();
  for (const quote of quotes) {
    const alreadyOpen = state.openOrders.some(
      (order) => order.runMode === "live" && order.status === "open" && isEquivalentQuote(order, quote, config),
    );
    if (alreadyOpen) continue;
    if (quote.source !== "inventory_exit" && quote.side !== "bid") continue;
    const key = `${quote.marketAppId}:${quote.outcome}:${quote.side}:${quote.source}`;
    const previous = deduped.get(key);
    if (!previous) {
      deduped.set(key, quote);
      continue;
    }
    if (quote.source === "spread") {
      if (spreadQuoteQuality(quote, state) > spreadQuoteQuality(previous, state)) deduped.set(key, quote);
      continue;
    }
    if (quote.notionalUsd > previous.notionalUsd) deduped.set(key, quote);
  }

  const all = [...deduped.values()];
  const exits = all.filter((quote) => quote.source === "inventory_exit").sort((a, b) => b.notionalUsd - a.notionalUsd);
  const reward = all
    .filter((quote) => quote.source === "reward")
    .sort((a, b) => (a.marketAppId === b.marketAppId ? b.notionalUsd - a.notionalUsd : a.marketAppId - b.marketAppId));
  const spread = all
    .filter((quote) => quote.source === "spread")
    .sort((a, b) => spreadQuoteQuality(b, state) - spreadQuoteQuality(a, state));

  return { reward, spread, exits };
}

function requiredBidUsdc(quote: AlphaQuote, config: AlphaConfig): number {
  return quote.notionalUsd * (1 + config.liveBidUsdcBufferBps / 10_000);
}

export async function runLiveTick(
  scan: AlphaScanResult,
  config: AlphaConfig,
  mode: Extract<AlphaMode, "live-dry-run" | "live">,
): Promise<LiveTickResult> {
  logLiveMemory("live_tick_start", {
    mode,
    markets: scan.markets.length,
    rewardMarkets: scan.rewardMarkets.length,
    orderbooks: scan.orderbooks.size,
  });
  if (mode === "live") validateLiveConfig(config);
  if (!config.walletAddress) throw new Error(`${mode} requires ALPHA_WALLET_ADDRESS or mnemonic-derived address`);

  const actions: LiveAction[] = [];
  const state = await loadAlphaState(config.stateKey, config.paperStartingBalanceUsd);
  logLiveMemory("after_state_load", {
    openOrders: state.openOrders.length,
    positions: Object.keys(state.positionsByMarket).length,
    spreadStats: Object.keys(state.spreadStatsByMarket).length,
    fills: state.fills.length,
    cancelled: state.cancelledOrders.length,
  });
  const liveClient = new AlphaSdkClient(config, mode === "live");
  const marketByAppId = new Map<number, AlphaMarket>();
  for (const market of [...scan.markets, ...scan.rewardMarkets]) {
    marketByAppId.set(market.marketAppId, market);
  }
  logLiveMemory("after_market_map", { marketMap: marketByAppId.size });
  const spreadStatsPrune = pruneSpreadStatsToActiveMarkets(state, new Set(marketByAppId.keys()));
  if (spreadStatsPrune.pruned > 0) {
    actions.push({
      kind: "skip",
      message: `Spread guardrails: pruned ${spreadStatsPrune.pruned} stale market stat row(s); retained ${spreadStatsPrune.retained} active row(s)`,
    });
  }
  logLiveMemory("after_spread_stats_prune", {
    spreadStats: spreadStatsPrune.retained,
    prunedSpreadStats: spreadStatsPrune.pruned,
  });

  const previousLiveOrders = state.openOrders.filter(
    (order) => order.runMode === "live" && order.liveEscrowAppId !== undefined && order.status === "open",
  );
  let walletOrders: OpenOrder[] = [];
  try {
    walletOrders = await loadWalletOpenOrders(liveClient, config.walletAddress, marketByAppId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ghillie-live] tick aborted during wallet open order sync: ${message}`);
    actions.push({ kind: "skip", message: `Tick aborted safely: ${message}` });
    state.strategyStats.lastRunMode = mode;
    if (mode === "live") await saveAlphaState(config.stateKey, state);
    return finalLiveTickResult(liveClient, config, actions, state, { refreshBalances: false });
  }
  logLiveMemory("after_wallet_open_orders", { walletOrders: walletOrders.length });
  const { synced: syncedLiveOrders, closedOrders } = mergeLiveOrdersFromWallet(state, walletOrders, marketByAppId);
  actions.push({ kind: "skip", message: `Synced ${syncedLiveOrders} open live order(s) from wallet` });
  logLiveMemory("after_merge_live_orders", { syncedLiveOrders, closedOrders: closedOrders.length, stateOpenOrders: state.openOrders.length });

  state.liveFillCursorByEscrow ??= {};
  state.liveFillEvents ??= [];
  const fillEvents = detectFillDeltasFromWallet({
    previousLiveOrders,
    walletOrders,
    cursor: state.liveFillCursorByEscrow,
  });
  for (const result of applyLiveFillEvents(state, fillEvents)) {
    if (result.applied) actions.push({ kind: "skip", message: result.message });
  }
  logLiveMemory("after_open_fill_ledger", {
    fillEvents: fillEvents.length,
    fills: state.fills.length,
    actions: actions.length,
  });

  let rawWalletPositions: WalletPosition[] = [];
  let positionsSynced = false;
  try {
    const positions = await liveClient.getPositions(config.walletAddress);
    rawWalletPositions = positions;
    positionsSynced = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ghillie-live] position sync failed: ${message}`);
    actions.push({ kind: "skip", message: `Position sync skipped: ${message}` });
  }

  if (closedOrders.length > 0 && positionsSynced) {
    const stateSharesBySide = new Map<string, number>();
    for (const position of Object.values(state.positionsByMarket)) {
      if (position.marketAppId === undefined) continue;
      stateSharesBySide.set(inventorySideKey(position.marketAppId, "YES"), position.yesShares);
      stateSharesBySide.set(inventorySideKey(position.marketAppId, "NO"), position.noShares);
    }
    const inventorySnapshot = buildInventorySnapshot(rawWalletPositions, walletOrders);
    const chainSharesBySide = new Map<string, number>();
    for (const [marketAppId, inventory] of inventorySnapshot) {
      chainSharesBySide.set(inventorySideKey(marketAppId, "YES"), inventory.yes.total);
      chainSharesBySide.set(inventorySideKey(marketAppId, "NO"), inventory.no.total);
    }
    const closed = classifyClosedOrdersAgainstInventory({
      closedOrders,
      cursor: state.liveFillCursorByEscrow,
      stateSharesBySide,
      chainSharesBySide,
    });
    for (const result of applyLiveFillEvents(state, closed.fills)) {
      if (result.applied) {
        actions.push({
          kind: "skip",
          message: result.message.replace(/^Live /, "Inferred live "),
        });
      }
    }
    if (closed.cancels.length > 0) {
      state.cancelledOrders.push(...closed.cancels);
      for (const cancelled of closed.cancels) {
        actions.push({
          kind: "skip",
          message: `Live cancel ${cancelled.title} ${cancelled.outcome} ${cancelled.side} escrowAppId=${cancelled.liveEscrowAppId}; unfilled ${cancelled.remainingShares.toFixed(6)} share(s)`,
        });
      }
    }
  } else if (closedOrders.length > 0 && !positionsSynced) {
    actions.push({
      kind: "skip",
      message: `Deferred classify of ${closedOrders.length} closed live order(s): wallet positions unavailable`,
    });
  }
  logLiveMemory("after_fill_ledger", {
    fillEvents: fillEvents.length,
    fills: state.fills.length,
    cancelled: state.cancelledOrders.length,
    actions: actions.length,
  });

  try {
    if (positionsSynced) {
      const migrated = migratePositionsToAppIdKeys(state);
      if (migrated > 0) {
        actions.push({ kind: "skip", message: `Migrated ${migrated} position key(s) onto marketAppId` });
      }
      const inventorySnapshot = buildInventorySnapshot(rawWalletPositions, walletOrders);
      const syncedPositions = syncPositionsFromInventory(state, inventorySnapshot, marketByAppId);
      actions.push({
        kind: "skip",
        message: `Synced ${syncedPositions} live position(s) from wallet free+escrow inventory`,
      });
      for (const mismatch of inventoryInvariantMismatches(state, inventorySnapshot)) {
        actions.push({ kind: "skip", message: mismatch.message });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ghillie-live] position sync failed: ${message}`);
    actions.push({ kind: "skip", message: `Position sync skipped: ${message}` });
    positionsSynced = false;
  }
  logLiveMemory("after_wallet_positions", {
    positionsSynced,
    walletPositions: rawWalletPositions.length,
    statePositions: Object.keys(state.positionsByMarket).length,
  });
  if (positionsSynced && rawWalletPositions.length > 0) {
    actions.push(
      ...(await runInventoryMergeLane({
        liveClient,
        config,
        mode,
        walletPositions: rawWalletPositions,
        walletOrders,
        state,
      })),
    );
    actions.push(
      ...(await runResolvedClaimLane({ liveClient, config, mode, walletPositions: rawWalletPositions, state })),
    );
  }
  logLiveMemory("after_recycling_lanes", { actions: actions.length });
  if (positionsSynced) {
    await reconcilePositions({ liveClient, config, mode, state, walletPositions: rawWalletPositions, walletOrders, actions });
  }
  logLiveMemory("after_position_reconcile", {
    positions: Object.keys(state.positionsByMarket).length,
    actions: actions.length,
  });
  accrueEstimatedRewards(state, config, Date.now(), {
    markets: [...scan.rewardMarkets, ...scan.markets],
    orderbooks: scan.orderbooks,
    walletAddress: config.walletAddress,
  });
  logLiveMemory("after_reward_accrual", { estimatedRewardsUsd: state.estimatedRewardsUsd.toFixed(6) });
  await refreshActualRewardsReceived({ config, mode, state, marketAppIds: [...marketByAppId.keys()], walletOrders, actions });
  logLiveMemory("after_actual_reward_refresh", {
    rewardsReceivedUsd: state.capitalLedger?.rewardsReceivedUsd?.toFixed(6),
    actions: actions.length,
  });
  updateUnrealisedPnl(state, scan.orderbooks);
  logLiveMemory("after_unrealised_pnl", { unrealisedPnl: state.unrealisedPnl.toFixed(6) });
  const spreadStatsUpdated = shouldTrackSpreadStats(config) ? updateSpreadMarketStats(state, scan, marketByAppId, config) : 0;
  actions.push({
    kind: "skip",
    message: shouldTrackSpreadStats(config)
      ? `Spread guardrails: updated ${spreadStatsUpdated} market health observation(s)`
      : "Spread guardrails disabled; skipped market health stats update",
  });
  logLiveMemory("after_spread_stats", { spreadStatsUpdated, spreadStats: Object.keys(state.spreadStatsByMarket).length });
  const allExecutionLanesDisabled = !config.enableRewardLane && !config.enableSpreadLane && !config.enableParityLane;
  if (allExecutionLanesDisabled) {
    actions.push({
      kind: "skip",
      message: "All execution lanes disabled (reward/spread/parity); reporting summary only",
    });
    state.strategyStats.lastRunMode = mode;
    if (mode === "live") await saveAlphaState(config.stateKey, state);
    return finalLiveTickResult(liveClient, config, actions, state);
  }

  const quotes: AlphaQuote[] = [];
  let blockedSpreadEntries = 0;
  for (const market of marketByAppId.values()) {
    const book = scan.orderbooks.get(market.marketAppId);
    if (!book) continue;
    for (const quote of generateQuotes(market, book, state, config)) {
      const rejection = spreadEntryRejection(quote, state, config);
      if (rejection) {
        blockedSpreadEntries += 1;
        actions.push({ kind: "skip", message: `Spread guardrail blocked ${quote.title} ${quote.outcome}: ${rejection}` });
        continue;
      }
      quotes.push(quote);
    }
  }
  logLiveMemory("after_quote_generation", {
    quotes: quotes.length,
    blockedSpreadEntries,
    rewardQuotes: quotes.filter((quote) => quote.source === "reward").length,
    spreadQuotes: quotes.filter((quote) => quote.source === "spread").length,
    exitQuotes: quotes.filter((quote) => quote.source === "inventory_exit").length,
  });
  actions.push({
    kind: "skip",
    message: `Generated ${quotes.length} quote candidate(s): reward=${quotes.filter((quote) => quote.source === "reward").length}, spread=${
      quotes.filter((quote) => quote.source === "spread").length
    }, exits=${quotes.filter((quote) => quote.source === "inventory_exit").length}, blockedSpreadEntries=${blockedSpreadEntries}`,
  });
  addInventoryExitDiagnostics(actions, state, quotes, scan, marketByAppId, config);
  logLiveMemory("after_inventory_exit_diagnostics", { actions: actions.length });
  const intendedQuoteByKey = new Map<string, AlphaQuote>();
  for (const quote of quotes) {
    if (!intendedQuoteByKey.has(quoteKey(quote))) intendedQuoteByKey.set(quoteKey(quote), quote);
  }
  logLiveMemory("after_intended_quote_map", { intendedQuotes: intendedQuoteByKey.size });

  const retainedRewardContracts = rewardContractsByMarket(state);
  for (const order of state.openOrders.filter((candidate) => candidate.runMode === "live" && candidate.status === "open")) {
    const escrowAppId = order.liveEscrowAppId;
    if (escrowAppId === undefined) continue;
    const market = marketByAppId.get(order.marketAppId);
    const book = scan.orderbooks.get(order.marketAppId);
    const intended = intendedQuoteByKey.get(quoteKey(order));
    const ageSeconds = orderAgeSeconds(order);
    const inRewardZone = rewardOrderInsideCurrentZone(order, market, book);
    const rewardMinContracts = rewardMinContractsForOrder(order, market);
    const aggregateRewardContracts = retainedRewardContracts.get(order.marketAppId) ?? 0;
    // A reward order only earns if the market's aggregate in-zone contracts meet
    // the market minimum. When the whole market's reward liquidity is below that
    // minimum, none of those orders earn, so a sub-minimum reward order must not
    // be kept resting (it would otherwise lock capital for zero reward forever).
    const rewardBelowMinimum =
      order.source === "reward" &&
      rewardMinContracts !== undefined &&
      aggregateRewardContracts + 1e-9 < rewardMinContracts;
    // A reward order in a market that no longer qualifies for the reward lane
    // (e.g. only a fabricated pool-fallback daily rate) earns nothing and must
    // not be kept resting. Only act when the market is in this scan to avoid
    // cancelling on a transient missing-market read.
    const rewardLaneDisallowed =
      order.source === "reward" && market !== undefined && !rewardLaneAllowsMarket(market, config);
    const rewardShouldDrop = rewardBelowMinimum || rewardLaneDisallowed;
    if (intended && isEquivalentQuote(order, intended, config) && !rewardShouldDrop) {
      order.reason = intended.reason;
      order.rewardEligible = intended.rewardEligible;
      order.rewardZoneDistanceCents = intended.rewardZoneDistanceCents;
      order.rewardMinContracts = intended.rewardMinContracts;
      order.estimatedRewardUsdPerDay = intended.estimatedRewardUsdPerDay;
      order.source = intended.source;
      actions.push({
        kind: "skip",
        message: `Kept live order escrowAppId=${escrowAppId}; quote still valid within ${config.quoteRefreshThresholdCents.toFixed(2)}c`,
      });
      continue;
    }
    const supportsRewardThreshold =
      rewardMinContracts !== undefined &&
      aggregateRewardContracts >= rewardMinContracts &&
      aggregateRewardContracts - order.remainingShares < rewardMinContracts;
    if (!rewardShouldDrop && inRewardZone && ageSeconds < config.rewardMinDwellSeconds) {
      actions.push({
        kind: "skip",
        message: `Kept reward-eligible order escrowAppId=${escrowAppId}; resting ${Math.floor(ageSeconds)}/${
          config.rewardMinDwellSeconds
        }s while still inside reward zone`,
      });
      continue;
    }
    if (!rewardShouldDrop && inRewardZone && supportsRewardThreshold) {
      actions.push({
        kind: "skip",
        message: `Kept reward-eligible order escrowAppId=${escrowAppId}; contributes to aggregate minimum ${rewardMinContracts?.toFixed(
          6,
        )} while inside reward zone`,
      });
      continue;
    }
    const reason = rewardLaneDisallowed
      ? "reward market has no genuine daily emission (pool-fallback only); order earns nothing"
      : rewardBelowMinimum
        ? `reward market aggregate ${aggregateRewardContracts.toFixed(6)} below minimum ${rewardMinContracts?.toFixed(6)} contract(s); order earns nothing`
        : intended
          ? `current quote moved ${quoteDeltaCents(order, intended).toFixed(2)}c`
          : "market no longer has a qualifying quote";
    if (order.source === "reward" && order.side === "bid" && ageSeconds < config.rewardMinDwellSeconds) {
      if (inRewardZone && !rewardShouldDrop) continue;
      actions.push({
        kind: "skip",
        message: `Reward order escrowAppId=${escrowAppId} is under minimum dwell but outside current reward zone; allowing refresh`,
      });
    }
    if (exitOrderWouldLoseMoney(order, state, config)) {
      const intendedSizeMismatch = intended !== undefined && !isEquivalentQuote(order, intended, config);
      if (controlledUnderwaterExitAllowed(order, state, config) && !intendedSizeMismatch) {
        actions.push({
          kind: "skip",
          message: `Kept controlled underwater exit escrowAppId=${escrowAppId}; within configured loss limits`,
        });
        continue;
      }
      if (intendedSizeMismatch) {
        actions.push({
          kind: "skip",
          message: `Inventory exit escrowAppId=${escrowAppId} is undersized vs unwind target ${intended.sizeShares.toFixed(
            6,
          )} share(s) / $${intended.notionalUsd.toFixed(2)}; allowing replacement`,
        });
      } else {
        actions.push({
          kind: "skip",
          message: `Inventory exit escrowAppId=${escrowAppId} is below tracked cost plus ${config.spreadExitEdgeCents.toFixed(2)}c; allowing cancellation`,
        });
      }
    } else if (order.source === "inventory_exit" && order.side === "ask" && orderAgeSeconds(order) < config.spreadExitMinDwellSeconds) {
      if (intended !== undefined && !isEquivalentQuote(order, intended, config)) {
        actions.push({
          kind: "skip",
          message: `Inventory exit escrowAppId=${escrowAppId} undersized vs unwind target; allowing refresh before dwell`,
        });
      } else {
        actions.push({
          kind: "skip",
          message: `Kept inventory exit escrowAppId=${escrowAppId}; resting ${Math.floor(orderAgeSeconds(order))}s/${config.spreadExitMinDwellSeconds}s before reconsidering`,
        });
        continue;
      }
    }
    if (order.source === "spread" && order.side === "bid" && orderAgeSeconds(order) < config.spreadEntryMinDwellSeconds) {
      if (config.enableSpreadLane && config.enableSpreadCapture) {
        actions.push({
          kind: "skip",
          message: `Kept spread entry escrowAppId=${escrowAppId}; resting ${Math.floor(orderAgeSeconds(order))}s/${config.spreadEntryMinDwellSeconds}s before reconsidering`,
        });
        continue;
      }
      actions.push({
        kind: "skip",
        message: `Spread lane disabled; allowing immediate cancellation of spread entry escrowAppId=${escrowAppId}`,
      });
    }
    if (mode === "live-dry-run") {
      actions.push({ kind: "cancel", message: `Would cancel live order escrowAppId=${escrowAppId}; ${reason}` });
      continue;
    }
    try {
      const result = await liveClient.cancelOrder({
        marketAppId: order.marketAppId,
        escrowAppId,
        orderOwner: order.owner ?? config.walletAddress,
      });
      if (result.success) {
        order.status = "cancelled";
        order.updatedAt = new Date().toISOString();
        decrementRewardContracts(retainedRewardContracts, order);
        state.cancelledOrders.push({ ...order });
        state.strategyStats.liveOrdersCancelled += 1;
        actions.push({ kind: "cancel", message: `Cancelled live order escrowAppId=${escrowAppId}; ${reason}` });
        await saveAlphaState(config.stateKey, state);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ghillie-live] cancel failed escrowAppId=${escrowAppId}: ${message}`);
      actions.push({ kind: "skip", message: `Cancel failed escrowAppId=${escrowAppId}: ${message}` });
    }
  }
  state.openOrders = state.openOrders.filter((order) => order.status === "open");
  logLiveMemory("after_order_refresh_cancellations", {
    openOrders: state.openOrders.length,
    cancelled: state.cancelledOrders.length,
    actions: actions.length,
  });

  let walletUsdcBalanceUsd: number | undefined;
  let walletAlgoBalance: number | undefined;
  try {
    [walletUsdcBalanceUsd, walletAlgoBalance] = await Promise.all([
      liveClient.getUsdcBalance(config.walletAddress),
      liveClient.getAlgoBalance(config.walletAddress),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ghillie-live] tick aborted during wallet balance sync: ${message}`);
    if (mode === "live") {
      actions.push({ kind: "skip", message: `Tick aborted safely: wallet balance sync failed: ${message}` });
      state.strategyStats.lastRunMode = mode;
      await saveAlphaState(config.stateKey, state);
      return finalLiveTickResult(liveClient, config, actions, state, { refreshBalances: false });
    }
    actions.push({ kind: "skip", message: `Wallet balance sync failed; dry-run bid budget checks disabled: ${message}` });
  }
  logLiveMemory("after_wallet_balances", {
    walletUsdcBalanceUsd: walletUsdcBalanceUsd?.toFixed(6),
    walletAlgoBalance: walletAlgoBalance?.toFixed(6),
  });

  actions.push(
    ...(await runParityLane({
      scan,
      state,
      config,
      liveClient,
      mode,
      walletUsdcBalanceUsd,
    })),
  );
  logLiveMemory("after_parity_lane", { actions: actions.length });

  const laneQueues = buildLaneQueues(quotes, state, config);
  logLiveMemory("after_lane_queues", {
    rewardQueue: laneQueues.reward.length,
    spreadQueue: laneQueues.spread.length,
    exitQueue: laneQueues.exits.length,
  });
  const openRewardOrders = state.openOrders.filter(
    (order) => order.runMode === "live" && order.status === "open" && order.source === "reward",
  ).length;
  const openSpreadEntryOrders = state.openOrders.filter(
    (order) => order.runMode === "live" && order.status === "open" && order.source === "spread",
  ).length;
  const rewardQueueCap = Math.max(0, config.rewardMaxLiveOpenOrders - openRewardOrders);
  const spreadQueueCap = Math.max(0, config.spreadMaxLiveOpenOrders - openSpreadEntryOrders);
  const heldInventoryNotionalUsd = getInventoryNotionalUsd(state);
  const inventoryGovernorActive =
    config.maxInventoryNotionalUsd > 0 && heldInventoryNotionalUsd >= config.maxInventoryNotionalUsd;
  if (inventoryGovernorActive) {
    actions.push({
      kind: "skip",
      message: `Inventory governor active: held inventory $${heldInventoryNotionalUsd.toFixed(
        2,
      )} >= ceiling $${config.maxInventoryNotionalUsd.toFixed(2)}; pausing new reward/spread bid entries (exits, merges, and claims still run)`,
    });
  }
  const pendingExitSlots = Math.min(config.spreadExitSlotReserve, laneQueues.exits.length);
  if (pendingExitSlots > 0) {
    actions.push({ kind: "skip", message: `Prioritising ${pendingExitSlots} inventory exit(s) ahead of new entries` });
  }
  if (rewardQueueCap === 0 && spreadQueueCap === 0 && laneQueues.exits.length === 0) {
    actions.push({ kind: "skip", message: "No reward or spread lane order slots available" });
    if (mode === "live") await saveAlphaState(config.stateKey, state);
    return finalLiveTickResult(liveClient, config, actions, state, { walletUsdcBalanceUsd, walletAlgoBalance });
  }
  const placementQueue: AlphaQuote[] = [];
  const added = new Set<string>();
  let rewardQueued = 0;
  let spreadQueued = 0;

  const pushQuote = (quote: AlphaQuote): boolean => {
    const key = `${quote.marketAppId}:${quote.outcome}:${quote.side}:${quote.source}:${quote.price.toFixed(6)}`;
    if (added.has(key)) return false;
    if (quote.source === "reward") {
      if (rewardQueued >= rewardQueueCap) return false;
      rewardQueued += 1;
    } else if (quote.source === "inventory_exit") {
      // Inventory exits clear existing risk and do not consume spread-entry slots.
    } else {
      if (spreadQueued >= spreadQueueCap) return false;
      spreadQueued += 1;
    }
    placementQueue.push(quote);
    added.add(key);
    return true;
  };

  for (const exit of laneQueues.exits.slice(0, pendingExitSlots)) {
    if (!pushQuote(exit)) break;
  }
  if (!inventoryGovernorActive) {
    for (const reward of laneQueues.reward) {
      pushQuote(reward);
    }
    for (const spread of laneQueues.spread) {
      pushQuote(spread);
    }
  }
  for (const exit of laneQueues.exits.slice(pendingExitSlots)) {
    pushQuote(exit);
  }

  const review = await runPlanReview({
    placementQueue,
    state,
    orderbooks: scan.orderbooks,
    markets: marketByAppId,
    config,
    walletUsdc: walletUsdcBalanceUsd,
    // Scan already resolved prefs (lane gate); reuse so we do not hit Spaces twice.
    operatorPreferences: scan.operatorPreferences ?? "",
  });
  placementQueue.length = 0;
  placementQueue.push(...review.placementQueue);
  actions.push(...review.actions);
  logLiveMemory("after_plan_review", {
    reviewed: review.reviewed,
    placementQueue: placementQueue.length,
    actions: actions.length,
  });

  const selectedRewardContractsByMarket = rewardContractsByMarket(state);
  const pendingRewardContractsByMarket = queuedRewardContractsByMarket(placementQueue);

  let remainingLiveBidUsdc = walletUsdcBalanceUsd;
  let reportedBidBudgetDepleted = false;
  const amarokRuntime = mode === "live" ? createAmarokRuntime(config) : undefined;
  try {
  for (const quote of placementQueue) {
    let quoteToPlace = quote;
    let pendingQuote = quote;
    const removePendingQuote = () => replacePendingRewardContracts(pendingRewardContractsByMarket, pendingQuote);
    const replacePendingQuote = (next: AlphaQuote) => {
      replacePendingRewardContracts(pendingRewardContractsByMarket, pendingQuote, next);
      pendingQuote = next;
    };
    if ((mode === "live" || mode === "live-dry-run") && quoteToPlace.side === "bid") {
      if (remainingLiveBidUsdc === undefined) {
        actions.push({ kind: "skip", message: `${quoteToPlace.title} ${quoteToPlace.outcome} bid: wallet USDC unavailable; skipping live bid placement` });
        removePendingQuote();
        continue;
      }
      const resized = resizeBidQuoteToBudget(quoteToPlace, remainingLiveBidUsdc, config);
      if (!resized.quote) {
        if (remainingLiveBidUsdc <= 0.000001) {
          if (!reportedBidBudgetDepleted) {
            actions.push({
              kind: "skip",
              message: `Bid budget depleted; skipping remaining bid candidates (lane minimums start at $${quoteMinNotionalUsd(
                quoteToPlace,
                config,
              ).toFixed(2)})`,
            });
            reportedBidBudgetDepleted = true;
          }
          removePendingQuote();
          continue;
        }
        actions.push({
          kind: "skip",
          message: `${quoteToPlace.title} ${quoteToPlace.outcome} bid: ${resized.reason ?? "insufficient wallet USDC for buffered order placement"}`,
        });
        removePendingQuote();
        continue;
      }
      if (resized.resized) {
        quoteToPlace = resized.quote;
        replacePendingQuote(quoteToPlace);
        actions.push({
          kind: "skip",
          message: `${quoteToPlace.title} ${quoteToPlace.outcome} bid: resized to $${quoteToPlace.notionalUsd.toFixed(
            2,
          )} to fit wallet USDC ${remainingLiveBidUsdc.toFixed(2)} with ${(config.liveBidUsdcBufferBps / 100).toFixed(2)}% buffer`,
        });
      }
    }
    const supportedRewardContracts =
      (selectedRewardContractsByMarket.get(quoteToPlace.marketAppId) ?? 0) + (pendingRewardContractsByMarket.get(quoteToPlace.marketAppId) ?? 0);
    if (
      quoteToPlace.source === "reward" &&
      quoteToPlace.rewardMinContracts !== undefined &&
      supportedRewardContracts < quoteToPlace.rewardMinContracts
    ) {
      actions.push({
        kind: "skip",
        message: `${quoteToPlace.title} aggregate reward contracts ${supportedRewardContracts.toFixed(6)} below minimum ${quoteToPlace.rewardMinContracts.toFixed(
          6,
        )}`,
      });
      removePendingQuote();
      continue;
    }
    const risk = checkQuoteRisk(quoteToPlace, state, config, mode);
    if (!risk.allowed) {
      actions.push({ kind: "skip", message: `${quoteToPlace.title} ${quoteToPlace.outcome} ${quoteToPlace.side}: ${risk.reason}` });
      removePendingQuote();
      continue;
    }
    if (mode === "live-dry-run") {
      removePendingQuote();
      if (quoteToPlace.side === "bid" && remainingLiveBidUsdc !== undefined) {
        remainingLiveBidUsdc = Math.max(0, remainingLiveBidUsdc - requiredBidUsdc(quoteToPlace, config));
      }
      if (quoteToPlace.rewardEligible) {
        addRewardContracts(selectedRewardContractsByMarket, quoteToPlace.marketAppId, quoteRewardContracts(quoteToPlace));
      }
      actions.push({
        kind: "place",
        message: `Would place ${quoteToPlace.source} ${quoteToPlace.title} ${quoteToPlace.outcome} ${quoteToPlace.side} ${quoteToPlace.price.toFixed(3)} size $${quoteToPlace.notionalUsd.toFixed(
          2,
        )} / ${quoteToPlace.sizeShares.toFixed(6)} shares; ${quoteToPlace.reason}`,
      });
      continue;
    }
    if (quoteToPlace.side === "ask" && quoteToPlace.source !== "inventory_exit") {
      actions.push({ kind: "skip", message: `${quoteToPlace.title} ${quoteToPlace.outcome} ask skipped unless it is an inventory exit` });
      removePendingQuote();
      continue;
    }
    removePendingQuote();
    try {
      if (!amarokRuntime || !config.walletAddress) {
        throw new Error("ALPHA_WALLET_MNEMONIC is required to place via Amarok");
      }
      const quoteResult = await amarokRuntime.client.getExecutionQuote(config.walletAddress, [
        {
          shapeKey: "alpha_place_limit_order",
          input: {
            marketAppId: quoteToPlace.marketAppId,
            outcome: quoteToPlace.outcome,
            side: quoteToPlace.side,
            price: quoteToPlace.price,
            sizeShares: quoteToPlace.sizeShares,
          },
        },
      ]);
      const parsed = parseExecutionQuotePayload(quoteResult.data);
      const result = await signAndSubmitUnsignedGroup({
        wallet: amarokRuntime.wallet,
        algodServer: config.algodServer,
        algodToken: config.algodToken,
        unsignedTxnsBase64: parsed.unsignedTxnsBase64,
        userSignIndexes: parsed.userSignIndexes,
        knownEscrowAppId: parsed.escrowAppId,
        createEscrowIndex: parsed.createEscrowIndex,
      });
      const tracked = toTrackedLiveOrder(quoteToPlace, result);
      if (tracked.status === "open") {
        state.openOrders.push(tracked);
      }
      const placeFill = buildPlaceTimeFillEvent({
        order: tracked,
        escrowAppId: result.escrowAppId,
        matchedShares: result.matchedQuantity ?? 0,
        matchedPrice: result.matchedPrice,
      });
      if (placeFill) {
        const fillResult = applyLiveFillEvents(state, [placeFill])[0];
        if (fillResult?.applied) actions.push({ kind: "skip", message: fillResult.message });
      }
      state.strategyStats.liveOrdersPlaced += 1;
      if (quoteToPlace.side === "bid" && remainingLiveBidUsdc !== undefined) {
        remainingLiveBidUsdc = Math.max(0, remainingLiveBidUsdc - requiredBidUsdc(quoteToPlace, config));
      }
      if (quoteToPlace.rewardEligible) {
        addRewardContracts(selectedRewardContractsByMarket, quoteToPlace.marketAppId, quoteRewardContracts(quoteToPlace));
      }
      actions.push({ kind: "place", message: `Placed ${quoteToPlace.title} ${quoteToPlace.outcome} ${quoteToPlace.side} escrowAppId=${result.escrowAppId}` });
      await saveAlphaState(config.stateKey, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ghillie-live] place failed ${quoteToPlace.title} ${quoteToPlace.outcome}: ${message}`);
      if (quoteToPlace.side === "bid" && message.includes("underflow on subtracting")) {
        remainingLiveBidUsdc = 0;
      }
      actions.push({ kind: "skip", message: `Place failed ${quoteToPlace.title} ${quoteToPlace.outcome}: ${message}` });
    }
  }
  } finally {
    await amarokRuntime?.close();
  }
  logLiveMemory("after_placements", {
    openOrders: state.openOrders.length,
    actions: actions.length,
  });
  state.strategyStats.lastRunMode = mode;
  if (mode === "live") await saveAlphaState(config.stateKey, state);
  logLiveMemory("after_final_state_save", { openOrders: state.openOrders.length });
  return finalLiveTickResult(liveClient, config, actions, state, { walletUsdcBalanceUsd, walletAlgoBalance });
}
