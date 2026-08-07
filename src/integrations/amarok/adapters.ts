import type { AlphaMarket, AlphaOrderbook, AlphaQuote, AlphaRewardInfo } from "../../alpha/alphaTypes.js";
import type { AlphaScanResult } from "../../alpha/alphaMarketScanner.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function unwrapData(payload: unknown): unknown {
  const record = asRecord(payload);
  if (!record) return payload;
  if ("data" in record) return record.data;
  return payload;
}

function rewardFromUnknown(raw: unknown): AlphaRewardInfo {
  const record = asRecord(raw) ?? {};
  const competition = asString(record.competitionLevel);
  return {
    isRewardMarket: asBool(record.isRewardMarket) ?? Boolean(asNumber(record.dailyRewardsUsd) ?? asNumber(record.estimatedUsdPerDay)),
    totalRewardsUsd: asNumber(record.totalRewardsUsd),
    rewardsPaidOutUsd: asNumber(record.rewardsPaidOutUsd),
    remainingRewardsUsd: asNumber(record.remainingRewardsUsd),
    dailyRewardsUsd: asNumber(record.dailyRewardsUsd) ?? asNumber(record.estimatedUsdPerDay),
    dailyRewardsSource: asString(record.dailyRewardsSource),
    lastPayoutUsd: asNumber(record.lastPayoutUsd),
    maxRewardSpreadCents: asNumber(record.maxRewardSpreadCents),
    minContracts: asNumber(record.minContracts),
    competitionLevel:
      competition === "low" || competition === "medium" || competition === "high" || competition === "unknown"
        ? competition
        : "unknown",
  };
}

export function marketFromAmarok(raw: unknown): AlphaMarket | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const marketAppId = asNumber(record.marketAppId);
  if (marketAppId === undefined) return undefined;
  const title = asString(record.title) ?? `market ${marketAppId}`;
  const status = asString(record.status) ?? "live";
  const resolved = asBool(record.resolved) ?? status.toLowerCase() === "resolved";
  const book = asRecord(record.book);
  const mid = asNumber(book?.mid);
  const bestBid = asNumber(book?.bestBid);
  const bestAsk = asNumber(book?.bestAsk);
  const yesPrice = asNumber(record.yesPrice) ?? mid ?? bestBid ?? bestAsk;
  return {
    id: asString(record.id) ?? String(marketAppId),
    marketAppId,
    slug: asString(record.slug),
    title,
    category: asString(record.category),
    status,
    closeTime: asString(record.closeTime),
    endTs: asNumber(record.endTs),
    resolved,
    yesPrice,
    noPrice: asNumber(record.noPrice) ?? (yesPrice !== undefined ? 1 - yesPrice : undefined),
    volume: asNumber(record.volume),
    liquidity: asNumber(record.liquidity),
    reward: rewardFromUnknown(record.reward ?? record),
    raw,
  };
}

type BookLevel = { price: number; quantityShares: number; owner?: string };

function parseBookLevels(raw: unknown): BookLevel[] {
  if (!Array.isArray(raw)) return [];
  const levels: BookLevel[] = [];
  for (const row of raw) {
    const record = asRecord(row);
    if (!record) continue;
    const price = asNumber(record.price) ?? asNumber(record.p);
    const quantityShares =
      asNumber(record.quantityShares) ?? asNumber(record.size) ?? asNumber(record.quantity) ?? asNumber(record.q);
    if (price === undefined || quantityShares === undefined || price <= 0 || quantityShares <= 0) continue;
    const owner = asString(record.owner) ?? asString(record.address);
    levels.push(owner ? { price, quantityShares, owner } : { price, quantityShares });
  }
  return levels;
}

/** Nominal size so top-of-book-only Amarok books still look two-sided (~$1 depth). */
function syntheticLevel(price: number | undefined, sizeHint?: number): BookLevel[] {
  if (price === undefined || price <= 0) return [];
  const quantityShares = sizeHint !== undefined && sizeHint > 0 ? sizeHint : Math.max(1, 1 / price);
  return [{ price, quantityShares }];
}

function firstNonEmptyLevels(...candidates: BookLevel[][]): BookLevel[] {
  for (const levels of candidates) {
    if (levels.length > 0) return levels;
  }
  return [];
}

function sideOrdersFromAmarok(
  book: Record<string, unknown>,
  side: "yes" | "no",
  bid: number | undefined,
  ask: number | undefined,
): { bids: BookLevel[]; asks: BookLevel[] } {
  const nested = asRecord(book[side]) ?? asRecord(book[`${side}SideOrders`]) ?? asRecord(book[`${side}Orders`]);
  const bids = firstNonEmptyLevels(
    parseBookLevels(nested?.bids),
    parseBookLevels(book[`${side}Bids`]),
    parseBookLevels(book[`${side}BidLevels`]),
    syntheticLevel(bid, asNumber(book[`${side}BidSize`]) ?? asNumber(book.bidSize)),
  );
  const asks = firstNonEmptyLevels(
    parseBookLevels(nested?.asks),
    parseBookLevels(book[`${side}Asks`]),
    parseBookLevels(book[`${side}AskLevels`]),
    syntheticLevel(ask, asNumber(book[`${side}AskSize`]) ?? asNumber(book.askSize)),
  );
  return { bids, asks };
}

export function orderbookFromAmarok(market: AlphaMarket, rawBook: unknown): AlphaOrderbook {
  const book = asRecord(rawBook) ?? {};
  const yesBid = asNumber(book.yesBid) ?? asNumber(book.bestBid);
  const yesAsk = asNumber(book.yesAsk) ?? asNumber(book.bestAsk);
  const noBid = asNumber(book.noBid);
  const noAsk = asNumber(book.noAsk);
  const yesSpread =
    asNumber(book.yesSpread) ??
    (yesBid !== undefined && yesAsk !== undefined ? yesAsk - yesBid : undefined) ??
    (asNumber(book.spreadBps) !== undefined ? asNumber(book.spreadBps)! / 10_000 : undefined);
  const noSpread = asNumber(book.noSpread) ?? (noBid !== undefined && noAsk !== undefined ? noAsk - noBid : undefined);
  const yesSideOrders = sideOrdersFromAmarok(book, "yes", yesBid, yesAsk);
  const noSideOrders = sideOrdersFromAmarok(book, "no", noBid, noAsk);
  return {
    marketId: market.id,
    marketAppId: market.marketAppId,
    slug: market.slug,
    source: "api",
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    yesMid: asNumber(book.yesMid) ?? asNumber(book.mid) ?? (yesBid !== undefined && yesAsk !== undefined ? (yesBid + yesAsk) / 2 : market.yesPrice),
    noMid: asNumber(book.noMid) ?? (noBid !== undefined && noAsk !== undefined ? (noBid + noAsk) / 2 : market.noPrice),
    yesSpread,
    noSpread,
    bestSpread: Math.max(yesSpread ?? 0, noSpread ?? 0) || undefined,
    yesSideOrders,
    noSideOrders,
    raw: rawBook,
  };
}

function quoteSourceFromKind(kind: string | undefined): AlphaQuote["source"] {
  if (kind === "lp_reward" || kind === "reward") return "reward";
  return "spread";
}

export function quotesFromAmarok(payload: unknown): AlphaQuote[] {
  const data = unwrapData(payload);
  const rows = Array.isArray(data) ? data : Array.isArray(asRecord(data)?.quotes) ? (asRecord(data)!.quotes as unknown[]) : [];
  const quotes: AlphaQuote[] = [];
  for (const [index, row] of rows.entries()) {
    const record = asRecord(row);
    if (!record) continue;
    const marketAppId = asNumber(record.marketAppId);
    const price = asNumber(record.price);
    const sizeShares = asNumber(record.sizeShares) ?? asNumber(record.size);
    const sideRaw = asString(record.side)?.toLowerCase();
    const outcomeRaw = asString(record.outcome)?.toUpperCase();
    if (marketAppId === undefined || price === undefined || sizeShares === undefined) continue;
    if (sideRaw !== "bid" && sideRaw !== "ask") continue;
    if (outcomeRaw !== "YES" && outcomeRaw !== "NO") continue;
    const source = quoteSourceFromKind(asString(record.kind) ?? asString(record.source));
    quotes.push({
      id: asString(record.id) ?? `amarok:${marketAppId}:${outcomeRaw}:${sideRaw}:${index}`,
      marketId: asString(record.marketId) ?? String(marketAppId),
      marketAppId,
      slug: asString(record.slug),
      title: asString(record.title) ?? `market ${marketAppId}`,
      outcome: outcomeRaw,
      side: sideRaw,
      price,
      sizeShares,
      notionalUsd: asNumber(record.notionalUsd) ?? price * sizeShares,
      reason: asString(record.reason) ?? asString(record.notes) ?? "Amarok suggested quote",
      rewardEligible: asBool(record.rewardEligible) ?? source === "reward",
      rewardZoneDistanceCents: asNumber(record.rewardZoneDistanceCents),
      rewardMinContracts: asNumber(record.rewardMinContracts),
      estimatedRewardUsdPerDay: asNumber(record.estimatedRewardUsdPerDay) ?? asNumber(record.estimatedUsdPerDay),
      source,
    });
  }
  return quotes;
}

function opportunityRowsFromPayload(payload: unknown, nestedKey: string): unknown[] {
  const data = unwrapData(payload);
  if (Array.isArray(data)) return data;
  const record = asRecord(data);
  if (!record) return [];
  if (Array.isArray(record[nestedKey])) return record[nestedKey] as unknown[];
  if (Array.isArray(record.opportunities)) return record.opportunities as unknown[];
  return [];
}

function withDefaultKind(row: unknown, defaultKind: string): unknown {
  const record = asRecord(row);
  if (!record) return row;
  if (asString(record.kind)) return row;
  return { ...record, kind: defaultKind };
}

/**
 * Adapt Amarok scan / opportunities / lane / quotes payloads into the Alpha scan DTO
 * used by liveTrader and paperTrader.
 */
export function scanFromAmarok(params: {
  scanPayload?: unknown;
  opportunitiesPayload?: unknown;
  rewardsPayload?: unknown;
  spreadsPayload?: unknown;
  parityPayload?: unknown;
  quotesPayload?: unknown;
}): AlphaScanResult {
  const scanData = asRecord(unwrapData(params.scanPayload)) ?? asRecord(params.scanPayload) ?? {};
  const marketRows =
    (Array.isArray(scanData.markets) ? scanData.markets : undefined) ??
    (Array.isArray(unwrapData(params.scanPayload)) ? (unwrapData(params.scanPayload) as unknown[]) : undefined) ??
    [];

  const markets: AlphaMarket[] = [];
  const orderbooks = new Map<number, AlphaOrderbook>();
  for (const row of marketRows) {
    const market = marketFromAmarok(row);
    if (!market || market.resolved || market.status !== "live") continue;
    markets.push(market);
    const rowRecord = asRecord(row);
    const bookRaw = rowRecord?.book ?? rowRecord?.orderbook ?? rowRecord?.orderBook;
    if (bookRaw) {
      orderbooks.set(market.marketAppId, orderbookFromAmarok(market, bookRaw));
    }
  }

  const opportunityRows = [
    ...opportunityRowsFromPayload(params.opportunitiesPayload, "opportunities"),
    ...opportunityRowsFromPayload(params.rewardsPayload, "rewards").map((row) => withDefaultKind(row, "lp_reward")),
    ...opportunityRowsFromPayload(params.spreadsPayload, "spreads").map((row) => withDefaultKind(row, "spread")),
    ...opportunityRowsFromPayload(params.parityPayload, "parity").map((row) => withDefaultKind(row, "parity")),
  ];

  const rewardByAppId = new Map<number, AlphaMarket>();
  for (const row of opportunityRows) {
    const record = asRecord(row);
    if (!record) continue;
    const kind = asString(record.kind) ?? "";
    if (!(kind.includes("reward") || kind === "lp_reward")) continue;
    const market = marketFromAmarok({
      ...record,
      reward: {
        isRewardMarket: true,
        dailyRewardsUsd: asNumber(record.estimatedUsdPerDay),
        competitionLevel: "unknown",
      },
      status: "live",
      resolved: false,
    });
    if (!market) continue;
    rewardByAppId.set(market.marketAppId, market);
    if (!markets.some((existing) => existing.marketAppId === market.marketAppId)) {
      markets.push(market);
    }
  }

  // Spreads / parity lane rows can still contribute market stubs for quoteEngine.
  for (const row of opportunityRows) {
    const record = asRecord(row);
    if (!record) continue;
    const kind = asString(record.kind) ?? "";
    if (kind.includes("reward") || kind === "lp_reward") continue;
    const market = marketFromAmarok({
      ...record,
      status: asString(record.status) ?? "live",
      resolved: false,
    });
    if (!market || market.resolved || market.status !== "live") continue;
    if (!markets.some((existing) => existing.marketAppId === market.marketAppId)) {
      markets.push(market);
    }
  }

  // Ensure every market has at least an empty/top book so quoteEngine can run.
  for (const market of markets) {
    if (!orderbooks.has(market.marketAppId)) {
      orderbooks.set(
        market.marketAppId,
        orderbookFromAmarok(market, {
          yesBid: market.yesPrice !== undefined ? Math.max(0.01, market.yesPrice - 0.01) : undefined,
          yesAsk: market.yesPrice !== undefined ? Math.min(0.99, market.yesPrice + 0.01) : undefined,
          mid: market.yesPrice,
        }),
      );
    }
  }

  const rewardMarkets = [...rewardByAppId.values()];
  if (rewardMarkets.length === 0) {
    for (const market of markets) {
      if (market.reward.isRewardMarket) rewardMarkets.push(market);
    }
  }

  // Attach Amarok suggested quotes onto market.raw for optional downstream use.
  const suggestedQuotes = quotesFromAmarok(params.quotesPayload);
  if (suggestedQuotes.length > 0) {
    for (const market of markets) {
      const related = suggestedQuotes.filter((quote) => quote.marketAppId === market.marketAppId);
      if (related.length === 0) continue;
      market.raw = { ...(asRecord(market.raw) ?? {}), amarokQuotes: related };
    }
  }

  return {
    markets,
    rewardMarkets,
    orderbooks,
  };
}
