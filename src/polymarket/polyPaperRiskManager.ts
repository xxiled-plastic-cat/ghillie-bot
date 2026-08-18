import type { PolyConfig } from "./polyConfig.js";
import type { PolyPaperModelState, PolyPaperQuote } from "./polyPaperTypes.js";

export type PolyPaperRiskDecision = {
  allowed: boolean;
  reason: string;
};

function openOrdersForLane(state: PolyPaperModelState, lane: PolyPaperQuote["lane"]): number {
  return state.openOrders.filter((order) => order.status === "open" && order.lane === lane).length;
}

function openBidExposure(state: PolyPaperModelState): number {
  return state.openOrders
    .filter((order) => order.status === "open" && order.side === "bid")
    .reduce((sum, order) => sum + order.price * order.remainingSize, 0);
}

function heldSize(state: PolyPaperModelState, tokenId: string): number {
  return state.positionsByTokenId[tokenId]?.size ?? 0;
}

function openAskSize(state: PolyPaperModelState, tokenId: string): number {
  return state.openOrders
    .filter((order) => order.status === "open" && order.side === "ask" && order.tokenId === tokenId)
    .reduce((sum, order) => sum + order.remainingSize, 0);
}

export function checkPolyPaperRisk(
  quote: PolyPaperQuote,
  state: PolyPaperModelState,
  config: PolyConfig,
): PolyPaperRiskDecision {
  if (quote.price <= 0 || quote.price >= 1)
    return { allowed: false, reason: "price outside range" };
  if (quote.size <= 0 || quote.notionalUsd <= 0)
    return { allowed: false, reason: "invalid size/notional" };
  if (openOrdersForLane(state, quote.lane) >= config.paperMaxOpenOrdersPerLane) {
    return { allowed: false, reason: `${quote.lane} lane open-order cap reached` };
  }
  if (quote.side === "bid") {
    const required = quote.notionalUsd;
    const reserved = openBidExposure(state);
    if (state.cash - reserved < required)
      return { allowed: false, reason: "insufficient available cash" };
    return { allowed: true, reason: "ok" };
  }
  const inventory = heldSize(state, quote.tokenId);
  if (quote.size + openAskSize(state, quote.tokenId) > inventory) {
    return { allowed: false, reason: "insufficient inventory for ask" };
  }
  return { allowed: true, reason: "ok" };
}
