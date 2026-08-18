/**
 * Risk exposure accounting (Phase 3).
 *
 * Single net formula for paper and live:
 *   inventoryNotional = Σ (yesShares * avgYesCost + noShares * avgNoCost)
 *   openBidNotional   = Σ open bid price * remainingShares  (mode-filtered)
 *   askCoverage       = Σ open ask remainingShares * avgCost(outcome)
 *                       (capped so coverage ≤ that side's inventory cost)
 *   netExposure       = openBidNotional + inventoryNotional - askCoverage
 *
 * Ask coverage uses avg cost (not ask price) so units stay cost-basis. Inventory
 * totals already include sell-escrow; subtracting ask coverage yields free
 * inventory cost + open bids without double-counting exits in flight.
 */
import type { AlphaConfig, AlphaMode } from "./alphaConfig.js";
import type { AlphaBotState, AlphaOutcome, AlphaPaperOrder, AlphaQuote } from "./alphaTypes.js";
import { getPosition } from "./inventoryView.js";

export type AlphaRiskDecision = {
  allowed: boolean;
  reason: string;
  riskLevel: "low" | "medium" | "high";
};

type QuoteLane = "reward" | "spread";

function matchesMode(order: { runMode?: "paper" | "live" }, mode: AlphaMode): boolean {
  const orderMode = order.runMode ?? "paper";
  if (mode === "live" || mode === "live-dry-run") return orderMode === "live";
  return orderMode === "paper";
}

function openOrders(state: AlphaBotState, mode: AlphaMode): AlphaPaperOrder[] {
  return state.openOrders.filter((order) => order.status === "open" && matchesMode(order, mode));
}

function positionCostUsd(position: {
  yesShares: number;
  noShares: number;
  avgYesCost: number;
  avgNoCost: number;
}): number {
  return position.yesShares * position.avgYesCost + position.noShares * position.avgNoCost;
}

function sideAvgCost(
  position: { avgYesCost: number; avgNoCost: number } | undefined,
  outcome: AlphaOutcome,
): number {
  if (!position) return 0;
  return outcome === "YES" ? position.avgYesCost : position.avgNoCost;
}

function sideShares(
  position: { yesShares: number; noShares: number } | undefined,
  outcome: AlphaOutcome,
): number {
  if (!position) return 0;
  return outcome === "YES" ? position.yesShares : position.noShares;
}

export function getInventoryNotionalUsd(state: AlphaBotState): number {
  return Object.values(state.positionsByMarket).reduce(
    (sum, position) => sum + positionCostUsd(position),
    0,
  );
}

export function getInventoryNotionalUsdForMarket(
  state: AlphaBotState,
  marketAppId: number,
): number {
  const position = getPosition(state, marketAppId);
  return position ? positionCostUsd(position) : 0;
}

export function getOpenBidNotionalUsd(
  state: AlphaBotState,
  mode: AlphaMode,
  marketAppId?: number,
): number {
  return openOrders(state, mode)
    .filter(
      (order) =>
        order.side === "bid" && (marketAppId === undefined || order.marketAppId === marketAppId),
    )
    .reduce((sum, order) => sum + order.price * order.remainingShares, 0);
}

/**
 * Cost-basis coverage from resting asks, capped per market/outcome so coverage
 * cannot exceed that side's inventory cost.
 */
export function getAskCoverageUsd(
  state: AlphaBotState,
  mode: AlphaMode,
  marketAppId?: number,
): number {
  const asks = openOrders(state, mode).filter(
    (order) =>
      order.side === "ask" && (marketAppId === undefined || order.marketAppId === marketAppId),
  );

  const remainingBySide = new Map<string, number>();
  for (const ask of asks) {
    const key = `${ask.marketAppId}:${ask.outcome}`;
    remainingBySide.set(key, (remainingBySide.get(key) ?? 0) + ask.remainingShares);
  }

  let coverage = 0;
  for (const [key, askShares] of remainingBySide) {
    const [appIdRaw, outcomeRaw] = key.split(":");
    const appId = Number(appIdRaw);
    const outcome = outcomeRaw as AlphaOutcome;
    const position = getPosition(state, appId);
    const avgCost = sideAvgCost(position, outcome);
    const held = sideShares(position, outcome);
    const coveredShares = Math.min(askShares, Math.max(0, held));
    coverage += coveredShares * Math.max(0, avgCost);
  }
  return coverage;
}

export function getNetExposureUsd(
  state: AlphaBotState,
  mode: AlphaMode,
  marketAppId?: number,
): number {
  const inventory =
    marketAppId === undefined
      ? getInventoryNotionalUsd(state)
      : getInventoryNotionalUsdForMarket(state, marketAppId);
  const bids = getOpenBidNotionalUsd(state, mode, marketAppId);
  const asks = getAskCoverageUsd(state, mode, marketAppId);
  return Math.max(0, bids + inventory - asks);
}

function resolveMarketAppId(state: AlphaBotState, marketId: string): number | undefined {
  const asNumber = Number(marketId);
  if (Number.isFinite(asNumber) && String(asNumber) === marketId) return asNumber;

  const fromPosition =
    state.positionsByMarket[marketId]?.marketAppId ??
    Object.values(state.positionsByMarket).find((candidate) => candidate.marketId === marketId)
      ?.marketAppId;
  if (fromPosition !== undefined) return fromPosition;

  const fromOrder = state.openOrders.find((order) => order.marketId === marketId)?.marketAppId;
  return fromOrder;
}

export function getMarketExposure(
  state: AlphaBotState,
  marketId: string,
  mode: AlphaMode = "paper",
): number {
  const marketAppId = resolveMarketAppId(state, marketId);
  if (marketAppId === undefined) {
    return openOrders(state, mode)
      .filter((order) => order.marketId === marketId && order.side === "bid")
      .reduce((sum, order) => sum + order.price * order.remainingShares, 0);
  }
  return getNetExposureUsd(state, mode, marketAppId);
}

export function getTotalExposure(state: AlphaBotState, mode: AlphaMode = "paper"): number {
  return getNetExposureUsd(state, mode);
}

function openAskShares(
  state: AlphaBotState,
  marketAppId: number,
  outcome: "YES" | "NO",
  mode: AlphaMode,
): number {
  return openOrders(state, mode)
    .filter(
      (order) =>
        order.marketAppId === marketAppId && order.outcome === outcome && order.side === "ask",
    )
    .reduce((sum, order) => sum + order.remainingShares, 0);
}

function laneFromSource(source: AlphaQuote["source"]): QuoteLane {
  return source === "reward" ? "reward" : "spread";
}

function laneFromQuote(quote: AlphaQuote): QuoteLane {
  return laneFromSource(quote.source);
}

function laneFromOrder(order: { source: AlphaQuote["source"] }): QuoteLane {
  return laneFromSource(order.source);
}

function laneOpenOrderCount(state: AlphaBotState, lane: QuoteLane, mode: AlphaMode): number {
  return openOrders(state, mode).filter((order) => laneFromOrder(order) === lane).length;
}

function laneOpenOrderCountByMarket(
  state: AlphaBotState,
  lane: QuoteLane,
  marketId: string,
  mode: AlphaMode,
): number {
  return openOrders(state, mode).filter(
    (order) => order.marketId === marketId && laneFromOrder(order) === lane,
  ).length;
}

function laneBidNotional(state: AlphaBotState, lane: QuoteLane, mode: AlphaMode): number {
  return openOrders(state, mode)
    .filter((order) => order.side === "bid" && laneFromOrder(order) === lane)
    .reduce((sum, order) => sum + order.price * order.remainingShares, 0);
}

function laneBidNotionalByMarket(
  state: AlphaBotState,
  lane: QuoteLane,
  marketId: string,
  mode: AlphaMode,
): number {
  return openOrders(state, mode)
    .filter(
      (order) =>
        order.side === "bid" && order.marketId === marketId && laneFromOrder(order) === lane,
    )
    .reduce((sum, order) => sum + order.price * order.remainingShares, 0);
}

export function checkQuoteRisk(
  quote: AlphaQuote,
  state: AlphaBotState,
  config: AlphaConfig,
  mode: AlphaMode,
): AlphaRiskDecision {
  const isInventoryExit = quote.source === "inventory_exit" && quote.side === "ask";
  const isEntryBid =
    quote.side === "bid" && (quote.source === "reward" || quote.source === "spread");
  const lane = laneFromQuote(quote);
  const laneMaxOrderSizeUsd = isInventoryExit
    ? config.inventoryExitMaxNotionalUsd
    : lane === "reward"
      ? config.rewardMaxOrderSizeUsd
      : config.spreadMaxOrderSizeUsd;
  const laneMaxMarketExposureUsd =
    lane === "reward" ? config.rewardMaxMarketExposureUsd : config.spreadMaxMarketExposureUsd;
  const laneMaxTotalExposureUsd =
    lane === "reward" ? config.rewardMaxTotalExposureUsd : config.spreadMaxTotalExposureUsd;
  const laneMaxLiveOpenOrders =
    lane === "reward" ? config.rewardMaxLiveOpenOrders : config.spreadMaxLiveOpenOrders;
  const laneMaxLiveOrdersPerMarket =
    lane === "reward" ? config.rewardMaxLiveOrdersPerMarket : config.spreadMaxLiveOrdersPerMarket;
  const liveLikeMode = mode === "live" || mode === "live-dry-run";

  if (quote.notionalUsd > laneMaxOrderSizeUsd + 1e-9) {
    return {
      allowed: false,
      reason: isInventoryExit
        ? "inventory exit size exceeds unwind notional cap"
        : `${lane} order size exceeds lane cap`,
      riskLevel: "high",
    };
  }
  // Inventory exits clear existing risk; do not let spread-entry open-order /
  // exposure caps block them from posting.
  if (!isInventoryExit) {
    if (liveLikeMode && laneOpenOrderCount(state, lane, mode) >= laneMaxLiveOpenOrders) {
      return {
        allowed: false,
        reason: `${lane} lane open order count exceeds cap`,
        riskLevel: "high",
      };
    }
    if (
      liveLikeMode &&
      laneOpenOrderCountByMarket(state, lane, quote.marketId, mode) >= laneMaxLiveOrdersPerMarket
    ) {
      return {
        allowed: false,
        reason: `${lane} lane market open order count exceeds cap`,
        riskLevel: "medium",
      };
    }
  }
  if (quote.price <= 0 || quote.price >= 1) {
    return { allowed: false, reason: "quote price outside valid range", riskLevel: "high" };
  }
  if (quote.rewardEligible === false && quote.source === "reward") {
    return {
      allowed: false,
      reason: "reward quote would sit outside reward zone",
      riskLevel: "medium",
    };
  }

  const addedExposure = quote.side === "bid" ? quote.notionalUsd : 0;

  // Keep legacy per-lane open-bid notional caps for lane budget control.
  if (
    !isInventoryExit &&
    laneBidNotionalByMarket(state, lane, quote.marketId, mode) + addedExposure >
      laneMaxMarketExposureUsd
  ) {
    return {
      allowed: false,
      reason: `${lane} market exposure would exceed lane cap`,
      riskLevel: "high",
    };
  }
  if (
    !isInventoryExit &&
    laneBidNotional(state, lane, mode) + addedExposure > laneMaxTotalExposureUsd
  ) {
    return {
      allowed: false,
      reason: `${lane} total exposure would exceed lane cap`,
      riskLevel: "high",
    };
  }

  // Net exposure (inventory + bids − ask coverage) must also fit lane caps.
  if (!isInventoryExit && addedExposure > 0) {
    if (
      getNetExposureUsd(state, mode, quote.marketAppId) + addedExposure >
      laneMaxMarketExposureUsd + 1e-9
    ) {
      return {
        allowed: false,
        reason: `${lane} market net exposure would exceed lane cap`,
        riskLevel: "high",
      };
    }
    if (getNetExposureUsd(state, mode) + addedExposure > laneMaxTotalExposureUsd + 1e-9) {
      return {
        allowed: false,
        reason: `${lane} total net exposure would exceed lane cap`,
        riskLevel: "high",
      };
    }
  }

  if (
    isEntryBid &&
    config.maxInventoryNotionalUsd > 0 &&
    getInventoryNotionalUsd(state) >= config.maxInventoryNotionalUsd - 1e-9
  ) {
    return {
      allowed: false,
      reason: "inventory notional at/above ALPHA_MAX_INVENTORY_NOTIONAL_USD ceiling",
      riskLevel: "high",
    };
  }

  if (mode === "paper" && quote.side === "bid" && quote.notionalUsd > state.cash) {
    return { allowed: false, reason: "bid requires more cash than available", riskLevel: "high" };
  }
  if (quote.side === "ask") {
    const position = getPosition(state, quote.marketAppId);
    const held = quote.outcome === "YES" ? (position?.yesShares ?? 0) : (position?.noShares ?? 0);
    if (
      quote.sizeShares + openAskShares(state, quote.marketAppId, quote.outcome, mode) >
      held + 1e-9
    ) {
      return {
        allowed: false,
        reason: "ask would sell more shares than current inventory",
        riskLevel: "high",
      };
    }
  }
  return { allowed: true, reason: "quote passed risk checks", riskLevel: "low" };
}
