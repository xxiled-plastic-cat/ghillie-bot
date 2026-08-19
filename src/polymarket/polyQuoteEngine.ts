import type { PolyConfig } from "./polyConfig.js";
import type { PolyPaperModelState, PolyPaperQuote } from "./polyPaperTypes.js";
import type { PolyParityPlan, PolyScanResult } from "./polyTypes.js";

function quoteSize(price: number, notionalUsd: number): number | undefined {
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return undefined;
  const size = notionalUsd / price;
  return Number.isFinite(size) && size > 0 ? size : undefined;
}

function makeQuoteId(parts: string[]): string {
  return `${parts.join(":")}:${Date.now()}`;
}

function canOpenMore(
  state: PolyPaperModelState,
  lane: PolyPaperQuote["lane"],
  config: PolyConfig,
): boolean {
  const openForLane = state.openOrders.filter(
    (order) => order.status === "open" && order.lane === lane,
  ).length;
  return openForLane < config.paperMaxOpenOrdersPerLane;
}

export function buildRewardQuotes(
  scan: PolyScanResult,
  state: PolyPaperModelState,
  config: PolyConfig,
): PolyPaperQuote[] {
  if (!config.enableRewardLane) return [];
  const quotes: PolyPaperQuote[] = [];
  for (const market of scan.rewardMarkets) {
    if (!market.active || market.closed) continue;
    if (!market.reward.isRewardMarket) continue;
    const pair = scan.tokenBooksByConditionId.get(market.conditionId);
    if (!pair) continue;
    for (const tokenAndBook of [
      { token: pair.yesToken, book: pair.yesBook },
      { token: pair.noToken, book: pair.noBook },
    ]) {
      if (!canOpenMore(state, "reward", config)) break;
      if (!tokenAndBook.token || !tokenAndBook.book?.bestBid) continue;
      const size = quoteSize(tokenAndBook.book.bestBid, config.paperRewardOrderSizeUsd);
      if (!size) continue;
      quotes.push({
        id: makeQuoteId(["reward", market.conditionId, tokenAndBook.token.tokenId]),
        lane: "reward",
        conditionId: market.conditionId,
        marketSlug: market.marketSlug,
        title: market.title,
        tokenId: tokenAndBook.token.tokenId,
        outcome: tokenAndBook.token.outcome,
        side: "bid",
        price: tokenAndBook.book.bestBid,
        size,
        notionalUsd: tokenAndBook.book.bestBid * size,
        rewardMaxSpreadCents: market.reward.rewardsMaxSpreadCents,
      });
    }
  }
  return quotes;
}

export function buildSpreadQuotes(
  scan: PolyScanResult,
  state: PolyPaperModelState,
  config: PolyConfig,
): PolyPaperQuote[] {
  if (!config.enableSpreadLane) return [];
  const quotes: PolyPaperQuote[] = [];
  for (const market of scan.markets) {
    if (!market.active || market.closed) continue;
    const pair = scan.tokenBooksByConditionId.get(market.conditionId);
    if (!pair) continue;
    for (const tokenAndBook of [
      { token: pair.yesToken, book: pair.yesBook },
      { token: pair.noToken, book: pair.noBook },
    ]) {
      if (!canOpenMore(state, "spread", config)) break;
      if (
        !tokenAndBook.token ||
        !tokenAndBook.book ||
        tokenAndBook.book.bestBid === undefined ||
        tokenAndBook.book.bestAsk === undefined
      )
        continue;
      const spreadCents = (tokenAndBook.book.bestAsk - tokenAndBook.book.bestBid) * 100;
      if (spreadCents < config.minSpreadCaptureCents) continue;
      const size = quoteSize(tokenAndBook.book.bestBid, config.paperSpreadOrderSizeUsd);
      if (!size) continue;
      quotes.push({
        id: makeQuoteId(["spread", market.conditionId, tokenAndBook.token.tokenId]),
        lane: "spread",
        conditionId: market.conditionId,
        marketSlug: market.marketSlug,
        title: market.title,
        tokenId: tokenAndBook.token.tokenId,
        outcome: tokenAndBook.token.outcome,
        side: "bid",
        price: tokenAndBook.book.bestBid,
        size,
        notionalUsd: tokenAndBook.book.bestBid * size,
      });
    }
  }
  return quotes;
}

function pushParityLeg(
  out: PolyPaperQuote[],
  args: {
    lane: "parity";
    groupId: string;
    conditionId: string;
    marketSlug?: string;
    title: string;
    tokenId: string;
    outcome: string;
    side: "bid" | "ask";
    price: number;
    targetNotionalUsd: number;
    edgeBps: number;
  },
): void {
  const size = quoteSize(args.price, args.targetNotionalUsd);
  if (!size) return;
  out.push({
    id: makeQuoteId(["parity", args.groupId, args.tokenId]),
    lane: "parity",
    conditionId: args.conditionId,
    marketSlug: args.marketSlug,
    title: args.title,
    tokenId: args.tokenId,
    outcome: args.outcome,
    side: args.side,
    price: args.price,
    size,
    notionalUsd: args.price * size,
    parityGroupId: args.groupId,
    parityEdgeBps: args.edgeBps,
  });
}

export function buildParityQuotes(
  scan: PolyScanResult,
  parityPlans: PolyParityPlan[],
  state: PolyPaperModelState,
  config: PolyConfig,
): PolyPaperQuote[] {
  if (!config.enableParityLane) return [];
  const quotes: PolyPaperQuote[] = [];
  for (const plan of parityPlans) {
    if (!canOpenMore(state, "parity", config)) break;
    const pair = scan.tokenBooksByConditionId.get(plan.conditionId);
    if (!pair?.yesToken || !pair.noToken) continue;
    const groupId = `${plan.type}:${plan.conditionId}:${Date.now()}`;
    if (plan.type === "PARITY") {
      pushParityLeg(quotes, {
        lane: "parity",
        groupId,
        conditionId: plan.conditionId,
        marketSlug: plan.marketSlug,
        title: plan.title,
        tokenId: pair.yesToken.tokenId,
        outcome: pair.yesToken.outcome,
        side: "bid",
        price: plan.yesPrice,
        targetNotionalUsd: config.paperParityOrderSizeUsd,
        edgeBps: plan.estimatedNetEdgeBps,
      });
      pushParityLeg(quotes, {
        lane: "parity",
        groupId,
        conditionId: plan.conditionId,
        marketSlug: plan.marketSlug,
        title: plan.title,
        tokenId: pair.noToken.tokenId,
        outcome: pair.noToken.outcome,
        side: "bid",
        price: plan.noPrice,
        targetNotionalUsd: config.paperParityOrderSizeUsd,
        edgeBps: plan.estimatedNetEdgeBps,
      });
      continue;
    }
    pushParityLeg(quotes, {
      lane: "parity",
      groupId,
      conditionId: plan.conditionId,
      marketSlug: plan.marketSlug,
      title: plan.title,
      tokenId: pair.yesToken.tokenId,
      outcome: pair.yesToken.outcome,
      side: "ask",
      price: plan.yesPrice,
      targetNotionalUsd: config.paperParityOrderSizeUsd,
      edgeBps: plan.estimatedNetEdgeBps,
    });
    pushParityLeg(quotes, {
      lane: "parity",
      groupId,
      conditionId: plan.conditionId,
      marketSlug: plan.marketSlug,
      title: plan.title,
      tokenId: pair.noToken.tokenId,
      outcome: pair.noToken.outcome,
      side: "ask",
      price: plan.noPrice,
      targetNotionalUsd: config.paperParityOrderSizeUsd,
      edgeBps: plan.estimatedNetEdgeBps,
    });
  }
  return quotes;
}
