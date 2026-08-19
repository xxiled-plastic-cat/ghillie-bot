import type { AlphaBotState, AlphaOrderbook, AlphaPaperOrder } from "./alphaTypes.js";
import { applyAskFillToPosition, applyBidFillToPosition } from "./positionAccounting.js";

function bestOpposingPrice(order: AlphaPaperOrder, book: AlphaOrderbook): number | undefined {
  if (order.outcome === "YES" && order.side === "bid") return book.yesAsk;
  if (order.outcome === "YES" && order.side === "ask") return book.yesBid;
  if (order.outcome === "NO" && order.side === "bid") return book.noAsk;
  return book.noBid;
}

function crossed(order: AlphaPaperOrder, price: number): boolean {
  return order.side === "bid" ? price <= order.price : price >= order.price;
}

export function detectPaperFills(
  state: AlphaBotState,
  books: Map<number, AlphaOrderbook>,
): AlphaPaperOrder[] {
  const fills: AlphaPaperOrder[] = [];
  for (const order of state.openOrders) {
    if (order.status !== "open") continue;
    const book = books.get(order.marketAppId);
    if (!book) continue;
    const opposing = bestOpposingPrice(order, book);
    if (opposing === undefined || !crossed(order, opposing)) continue;
    const shares = order.remainingShares;
    if (shares <= 0) continue;
    order.filledShares += shares;
    order.remainingShares = 0;
    order.status = "filled";
    order.updatedAt = new Date().toISOString();
    if (order.side === "bid") applyBidFillToPosition(state, order, shares);
    else applyAskFillToPosition(state, order, shares, order.price, { updateCash: true });
    fills.push({ ...order });
  }
  if (fills.length > 0) {
    state.fills.push(...fills);
  }
  return fills;
}

export function cancelStalePaperOrders(
  state: AlphaBotState,
  staleOrderSeconds = 45,
): AlphaPaperOrder[] {
  const now = Date.now();
  const cancelled: AlphaPaperOrder[] = [];
  for (const order of state.openOrders) {
    if (order.status !== "open") continue;
    const ageSeconds = (now - Date.parse(order.createdAt)) / 1000;
    if (ageSeconds < staleOrderSeconds) continue;
    order.status = "expired";
    order.updatedAt = new Date().toISOString();
    if (order.side === "bid") {
      state.cash += order.price * order.remainingShares;
    }
    cancelled.push({ ...order });
  }
  state.cancelledOrders.push(...cancelled);
  state.openOrders = state.openOrders.filter((order) => order.status === "open");
  return cancelled;
}
