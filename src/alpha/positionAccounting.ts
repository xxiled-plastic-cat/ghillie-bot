import type { AlphaBotState, AlphaOutcome, AlphaPaperOrder } from "./alphaTypes.js";
import { ensurePositionByAppId } from "./inventoryView.js";

export function ensurePosition(
  state: AlphaBotState,
  order: Pick<AlphaPaperOrder, "marketId" | "marketAppId" | "slug" | "title">,
): AlphaBotState["positionsByMarket"][string] {
  if (order.marketAppId === undefined) {
    throw new Error("ensurePosition requires marketAppId for canonical inventory keying");
  }
  return ensurePositionByAppId(state, {
    marketAppId: order.marketAppId,
    marketId: order.marketId,
    slug: order.slug,
    title: order.title,
  });
}

export function applyBidFillToPosition(
  state: AlphaBotState,
  order: Pick<AlphaPaperOrder, "marketId" | "marketAppId" | "slug" | "title" | "outcome" | "price">,
  shares: number,
  price: number = order.price,
): void {
  const position = ensurePosition(state, order);
  if (order.outcome === "YES") {
    const cost = position.yesShares * position.avgYesCost + shares * price;
    position.yesShares += shares;
    position.avgYesCost = position.yesShares > 0 ? cost / position.yesShares : 0;
  } else {
    const cost = position.noShares * position.avgNoCost + shares * price;
    position.noShares += shares;
    position.avgNoCost = position.noShares > 0 ? cost / position.noShares : 0;
  }
}

export function applyAskFillToPosition(
  state: AlphaBotState,
  order: Pick<AlphaPaperOrder, "marketId" | "marketAppId" | "slug" | "title" | "outcome" | "price">,
  shares: number,
  price: number = order.price,
  options: { updateCash?: boolean } = {},
): number {
  const position = ensurePosition(state, order);
  const avgCost = order.outcome === "YES" ? position.avgYesCost : position.avgNoCost;
  const pnl = (price - avgCost) * shares;
  if (order.outcome === "YES") position.yesShares = Math.max(0, position.yesShares - shares);
  else position.noShares = Math.max(0, position.noShares - shares);
  if (order.outcome === "YES" && position.yesShares <= 0) position.avgYesCost = 0;
  if (order.outcome === "NO" && position.noShares <= 0) position.avgNoCost = 0;
  position.realisedPnl += pnl;
  state.realisedPnl += pnl;
  if (options.updateCash) state.cash += price * shares;
  return pnl;
}

export function positionShares(
  position: { yesShares: number; noShares: number },
  outcome: AlphaOutcome,
): number {
  return outcome === "YES" ? position.yesShares : position.noShares;
}
