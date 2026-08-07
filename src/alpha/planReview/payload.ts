import { getInventoryNotionalUsd } from "../alphaRiskManager.js";
import { getPosition } from "../inventoryView.js";
import type { AlphaBotState, AlphaMarket, AlphaOrderbook, AlphaOutcome, AlphaQuote } from "../alphaTypes.js";

export type PlanReviewBookSnippet = {
  bid?: number;
  ask?: number;
  spreadCents?: number;
  volume?: number;
  twoSided: boolean;
};

export type PlanReviewPlannedEntry = {
  id: string;
  source: "reward" | "spread";
  marketAppId: number;
  title: string;
  outcome: AlphaOutcome;
  side: "bid" | "ask";
  price: number;
  shares: number;
  notionalUsd: number;
  hostReason: string;
  book: PlanReviewBookSnippet;
  postFillInventory: { yes: number; no: number };
};

export type PlanReviewPayload = {
  portfolio: {
    walletUsdc?: number;
    heldInventoryUsd: number;
    positions: Array<{
      appId: number;
      title: string;
      yes: number;
      no: number;
      avgYesCost: number;
      avgNoCost: number;
    }>;
  };
  openOrders: Array<{
    appId: number;
    side: string;
    outcome: string;
    price: number;
    shares: number;
    source: string;
  }>;
  planned: PlanReviewPlannedEntry[];
  constraints: {
    inventoryCeilingUsd: number;
    maxSingleOrderUsd: number;
  };
};

export function isEntryQuote(quote: AlphaQuote): quote is AlphaQuote & { source: "reward" | "spread" } {
  return quote.source === "reward" || quote.source === "spread";
}

export function entryReviewId(quote: AlphaQuote, index: number): string {
  return `entry-${index}-${quote.marketAppId}-${quote.outcome}-${quote.source}`;
}

function outcomeBook(book: AlphaOrderbook | undefined, outcome: AlphaOutcome): {
  bid?: number;
  ask?: number;
  spread?: number;
} {
  if (!book) return {};
  return outcome === "YES"
    ? { bid: book.yesBid, ask: book.yesAsk, spread: book.yesSpread }
    : { bid: book.noBid, ask: book.noAsk, spread: book.noSpread };
}

export function computePostFillInventory(
  state: AlphaBotState,
  quote: AlphaQuote,
): { yes: number; no: number } {
  const position = getPosition(state, quote.marketAppId);
  let yes = position?.yesShares ?? 0;
  let no = position?.noShares ?? 0;
  if (quote.side === "bid") {
    if (quote.outcome === "YES") yes += quote.sizeShares;
    else no += quote.sizeShares;
  } else {
    // Entry reviews are bids; keep ask path for completeness.
    if (quote.outcome === "YES") yes = Math.max(0, yes - quote.sizeShares);
    else no = Math.max(0, no - quote.sizeShares);
  }
  return { yes, no };
}

export function buildPlanReviewPayload(input: {
  entryQuotes: AlphaQuote[];
  state: AlphaBotState;
  orderbooks: Map<number, AlphaOrderbook>;
  markets: Map<number, AlphaMarket>;
  walletUsdc?: number;
  inventoryCeilingUsd: number;
  maxSingleOrderUsd: number;
}): PlanReviewPayload {
  const marketIds = new Set(input.entryQuotes.map((quote) => quote.marketAppId));

  const positions = Object.values(input.state.positionsByMarket)
    .filter((position) => position.marketAppId !== undefined && marketIds.has(position.marketAppId))
    .map((position) => ({
      appId: position.marketAppId!,
      title: position.title,
      yes: position.yesShares,
      no: position.noShares,
      avgYesCost: position.avgYesCost,
      avgNoCost: position.avgNoCost,
    }));

  const openOrders = input.state.openOrders
    .filter((order) => order.status === "open" && marketIds.has(order.marketAppId))
    .map((order) => ({
      appId: order.marketAppId,
      side: order.side,
      outcome: order.outcome,
      price: order.price,
      shares: order.remainingShares,
      source: order.source,
    }));

  const planned: PlanReviewPlannedEntry[] = input.entryQuotes.map((quote, index) => {
    const book = input.orderbooks.get(quote.marketAppId);
    const market = input.markets.get(quote.marketAppId);
    const stats = input.state.spreadStatsByMarket[String(quote.marketAppId)];
    const side = outcomeBook(book, quote.outcome);
    const twoSided = side.bid !== undefined && side.ask !== undefined;
    return {
      id: entryReviewId(quote, index),
      source: quote.source as "reward" | "spread",
      marketAppId: quote.marketAppId,
      title: quote.title,
      outcome: quote.outcome,
      side: quote.side,
      price: quote.price,
      shares: quote.sizeShares,
      notionalUsd: quote.notionalUsd,
      hostReason: quote.reason,
      book: {
        bid: side.bid,
        ask: side.ask,
        spreadCents: side.spread !== undefined ? side.spread * 100 : undefined,
        volume: market?.volume ?? stats?.volume,
        twoSided,
      },
      postFillInventory: computePostFillInventory(input.state, quote),
    };
  });

  return {
    portfolio: {
      walletUsdc: input.walletUsdc,
      heldInventoryUsd: getInventoryNotionalUsd(input.state),
      positions,
    },
    openOrders,
    planned,
    constraints: {
      inventoryCeilingUsd: input.inventoryCeilingUsd,
      maxSingleOrderUsd: input.maxSingleOrderUsd,
    },
  };
}
