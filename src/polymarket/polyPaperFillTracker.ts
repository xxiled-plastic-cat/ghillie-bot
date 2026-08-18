import type { PolyConfig } from "./polyConfig.js";
import type {
  PolyPaperModel,
  PolyPaperModelState,
  PolyPaperOrder,
  PolyPaperQuote,
} from "./polyPaperTypes.js";
import type { PolyScanResult } from "./polyTypes.js";

function nowIso(): string {
  return new Date().toISOString();
}

function toOrder(quote: PolyPaperQuote): PolyPaperOrder {
  const now = nowIso();
  return {
    ...quote,
    createdAt: now,
    updatedAt: now,
    status: "open",
    filledSize: 0,
    remainingSize: quote.size,
    filledNotionalUsd: 0,
    reservedUsd: quote.side === "bid" ? quote.notionalUsd : 0,
    quoteDistanceBpsSum: 0,
    quoteDistanceSamples: 0,
  };
}

export function placePolyPaperQuote(state: PolyPaperModelState, quote: PolyPaperQuote): void {
  state.openOrders.push(toOrder(quote));
  state.metrics.quotesPlaced += 1;
  state.metrics.quotesByLane[quote.lane] += 1;
}

function getOrderbook(scan: PolyScanResult, tokenId: string) {
  return scan.orderbooksByTokenId.get(tokenId);
}

function bestSameSidePrice(order: PolyPaperOrder, scan: PolyScanResult): number | undefined {
  const book = getOrderbook(scan, order.tokenId);
  if (!book) return undefined;
  return order.side === "bid" ? book.bestBid : book.bestAsk;
}

function bestOpposingPrice(order: PolyPaperOrder, scan: PolyScanResult): number | undefined {
  const book = getOrderbook(scan, order.tokenId);
  if (!book) return undefined;
  return order.side === "bid" ? book.bestAsk : book.bestBid;
}

function opposingDepth(order: PolyPaperOrder, scan: PolyScanResult): number | undefined {
  const book = getOrderbook(scan, order.tokenId);
  if (!book) return undefined;
  if (order.side === "bid") return book.asks[0]?.size;
  return book.bids[0]?.size;
}

function crossed(order: PolyPaperOrder, opposingPrice: number): boolean {
  return order.side === "bid" ? order.price >= opposingPrice : order.price <= opposingPrice;
}

function ageSeconds(order: PolyPaperOrder): number {
  return Math.max(0, (Date.now() - Date.parse(order.createdAt)) / 1000);
}

function updateQuoteDistance(
  order: PolyPaperOrder,
  scan: PolyScanResult,
  state: PolyPaperModelState,
): void {
  const sameSide = bestSameSidePrice(order, scan);
  if (sameSide === undefined || sameSide <= 0) return;
  const distance =
    order.side === "bid"
      ? Math.max(0, (sameSide - order.price) / sameSide) * 10_000
      : Math.max(0, (order.price - sameSide) / sameSide) * 10_000;
  order.quoteDistanceBpsSum += distance;
  order.quoteDistanceSamples += 1;
  state.metrics.quoteDistanceBpsSum += distance;
  state.metrics.quoteDistanceSamples += 1;
}

function ensurePosition(state: PolyPaperModelState, order: PolyPaperOrder) {
  state.positionsByTokenId[order.tokenId] ??= {
    tokenId: order.tokenId,
    outcome: order.outcome,
    conditionId: order.conditionId,
    marketSlug: order.marketSlug,
    title: order.title,
    size: 0,
    avgCost: 0,
    realisedPnl: 0,
    unrealisedPnl: 0,
  };
  return state.positionsByTokenId[order.tokenId];
}

function applyBidFill(
  state: PolyPaperModelState,
  order: PolyPaperOrder,
  fillSize: number,
  fillPrice: number,
): void {
  const position = ensurePosition(state, order);
  const totalCost = position.size * position.avgCost + fillSize * fillPrice;
  position.size += fillSize;
  position.avgCost = position.size > 0 ? totalCost / position.size : 0;
  state.cash -= fillSize * fillPrice;
}

function applyAskFill(
  state: PolyPaperModelState,
  order: PolyPaperOrder,
  fillSize: number,
  fillPrice: number,
): void {
  const position = ensurePosition(state, order);
  const realised = (fillPrice - position.avgCost) * fillSize;
  position.size = Math.max(0, position.size - fillSize);
  position.realisedPnl += realised;
  state.metrics.realisedPnl += realised;
  state.cash += fillSize * fillPrice;
}

function fillOrder(
  state: PolyPaperModelState,
  order: PolyPaperOrder,
  fillSize: number,
  fillPrice: number,
): void {
  if (fillSize <= 0) return;
  const appliedSize = Math.min(order.remainingSize, fillSize);
  if (appliedSize <= 0) return;
  if (order.side === "bid") applyBidFill(state, order, appliedSize, fillPrice);
  else applyAskFill(state, order, appliedSize, fillPrice);
  order.filledSize += appliedSize;
  order.remainingSize -= appliedSize;
  order.filledNotionalUsd += appliedSize * fillPrice;
  order.updatedAt = nowIso();
  if (order.remainingSize <= 0.000001) {
    order.status = "filled";
    order.filledAt = order.updatedAt;
    state.fills.push({ ...order });
    state.metrics.filledCount += 1;
    state.metrics.fillsByLane[order.lane] += 1;
    const seconds = (Date.parse(order.filledAt) - Date.parse(order.createdAt)) / 1000;
    if (Number.isFinite(seconds) && seconds >= 0) state.metrics.fillSeconds.push(seconds);
  }
}

function balancedFillSize(order: PolyPaperOrder, scan: PolyScanResult, config: PolyConfig): number {
  const depth = opposingDepth(order, scan) ?? 0;
  const age = ageSeconds(order);
  const ttl = Math.max(config.paperOrderTtlSeconds, 1);
  const ageRatio = Math.min(1, age / ttl);
  const probability = Math.min(
    1,
    Math.max(0, config.paperBalancedBaseFillProb + config.paperBalancedAgeWeight * ageRatio),
  );
  const sameSide = bestSameSidePrice(order, scan);
  const competitiveness =
    sameSide !== undefined && sameSide > 0
      ? order.side === "bid"
        ? Math.max(0, 1 - (sameSide - order.price) / sameSide)
        : Math.max(0, 1 - (order.price - sameSide) / sameSide)
      : 0.2;
  if (Math.random() > probability * competitiveness) return 0;
  const depthCap =
    depth > 0 ? Math.max(0.1, Math.min(1, depth / Math.max(order.remainingSize, 0.000001))) : 0.25;
  const randomFill = 0.2 + Math.random() * 0.8;
  return order.remainingSize * Math.min(1, depthCap * randomFill);
}

export function processPolyPaperFills(
  model: PolyPaperModel,
  state: PolyPaperModelState,
  scan: PolyScanResult,
  config: PolyConfig,
): void {
  for (const order of state.openOrders) {
    if (order.status !== "open") continue;
    updateQuoteDistance(order, scan, state);
    const opposing = bestOpposingPrice(order, scan);
    if (opposing === undefined) continue;
    const crossedNow = crossed(order, opposing);
    const oldEnough = ageSeconds(order) >= config.paperMinDwellSeconds;
    if (!crossedNow || !oldEnough) continue;
    if (model === "conservative") {
      fillOrder(state, order, order.remainingSize, opposing);
      continue;
    }
    const size = balancedFillSize(order, scan, config);
    fillOrder(state, order, size, opposing);
  }
}

export function expireStalePolyPaperOrders(state: PolyPaperModelState, config: PolyConfig): void {
  for (const order of state.openOrders) {
    if (order.status !== "open") continue;
    if (ageSeconds(order) < config.paperOrderTtlSeconds) continue;
    order.status = "expired";
    order.updatedAt = nowIso();
    state.cancelledOrders.push({ ...order });
    state.metrics.expiredByLane[order.lane] += 1;
  }
  state.openOrders = state.openOrders.filter((order) => order.status === "open");
}
