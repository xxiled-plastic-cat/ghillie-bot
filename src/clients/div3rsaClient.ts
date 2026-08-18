import { Div3rsaFiClient, type MarketSummary } from "@div3rsafi/sdk";

import type {
  LadderSnapshot,
  Market,
  MarketStatus,
  OraclePrice,
  Orderbook,
  RewardMarket,
  Timeframe,
} from "../types/market.js";
import { normalizePrice } from "../utils/math.js";

const client = new Div3rsaFiClient();

function toTimeframe(value: number): Timeframe {
  if (value === 3) return "hourly";
  if (value === 0) return "daily";
  if (value === 1) return "weekly";
  if (value === 2) return "monthly";
  return "unknown";
}

function toStatus(value: number): MarketStatus {
  if (value === 0) return "open";
  if (value === 1) return "locked";
  if (value === 3) return "settled";
  if (value === 2) return "expired";
  return "unknown";
}

function toUnderlying(assetLabel: string): string {
  return assetLabel.split("/")[0] ?? assetLabel;
}

function toBaseMarketId(rawId: string): number {
  const parsed = Number.parseInt(rawId.split(":")[0] ?? rawId, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid market id: ${rawId}`);
  }
  return parsed;
}

function normalizeStrike(value: number): number {
  if (!Number.isFinite(value)) return value;
  // SDK examples and REST responses expose strikes in cents.
  return value / 100;
}

function toMarketRows(
  summary: MarketSummary,
  rows: Awaited<ReturnType<typeof client.getLadder>>,
): Market[] {
  return rows.map((row) => ({
    id: `${summary.market_id}:${row.strike_index}`,
    marketGroupId: String(summary.market_id),
    strikeIndex: row.strike_index,
    underlying: toUnderlying(summary.asset_label),
    timeframe: toTimeframe(summary.timeframe),
    strike: normalizeStrike(row.strike),
    expiryTs: summary.expiration,
    haltTs: summary.halt_timestamp,
    status: toStatus(summary.status),
    yesBid: normalizePrice(row.yes_best_bid),
    yesAsk: normalizePrice(row.yes_best_ask),
    noBid: normalizePrice(row.no_best_bid),
    noAsk: normalizePrice(row.no_best_ask),
    raw: { summary, row },
  }));
}

export async function getMarkets(): Promise<Market[]> {
  const summaries = await client.listMarkets({ status: "active" });
  const ladderRows = await Promise.all(
    summaries.map(async (summary) => ({
      summary,
      rows: await client.getLadder(summary.market_id),
    })),
  );
  return ladderRows.flatMap(({ summary, rows }) => toMarketRows(summary, rows));
}

export async function getOrderbook(marketId: string): Promise<Orderbook> {
  const baseId = toBaseMarketId(marketId);
  const ladder = await client.getLadder(baseId);
  const books = await Promise.all(
    ladder.map(async (row) => {
      const book = await client.getOrderBook(baseId, row.strike_index);
      return {
        strikeIndex: row.strike_index,
        strike: normalizeStrike(row.strike),
        yesBuys: book.yes_buys.map((x) => ({
          price: normalizePrice(x.price) ?? 0,
          quantity: x.quantity,
        })),
        yesSells: book.yes_sells.map((x) => ({
          price: normalizePrice(x.price) ?? 0,
          quantity: x.quantity,
        })),
        noBuys: book.no_buys.map((x) => ({
          price: normalizePrice(x.price) ?? 0,
          quantity: x.quantity,
        })),
        noSells: book.no_sells.map((x) => ({
          price: normalizePrice(x.price) ?? 0,
          quantity: x.quantity,
        })),
      };
    }),
  );
  return { marketId: String(baseId), books };
}

export async function getLadderSnapshots(): Promise<LadderSnapshot[]> {
  const summaries = await client.listMarkets({ status: "active" });
  const snapshots = await Promise.all(
    summaries.map(async (summary) => {
      const rows = await client.getLadder(summary.market_id);
      return {
        marketId: String(summary.market_id),
        underlying: toUnderlying(summary.asset_label),
        timeframe: toTimeframe(summary.timeframe),
        expiryTs: summary.expiration,
        rows: rows.map((row) => ({
          strikeIndex: row.strike_index,
          strike: normalizeStrike(row.strike),
          yesBid: normalizePrice(row.yes_best_bid),
          yesAsk: normalizePrice(row.yes_best_ask),
          noBid: normalizePrice(row.no_best_bid),
          noAsk: normalizePrice(row.no_best_ask),
        })),
        raw: { summary, rows },
      };
    }),
  );
  return snapshots;
}

export async function getOraclePrices(): Promise<OraclePrice[]> {
  const prices = await client.getPrices();
  return prices.map((price) => ({
    underlying: toUnderlying(price.asset),
    price: price.price_cents / 100,
    timestamp: price.timestamp,
    isStale: price.is_stale,
    raw: price,
  }));
}

export async function getRewardMarkets(): Promise<RewardMarket[]> {
  const markets = await client.getRewardMarkets();
  return markets.map((market) => ({
    marketId: String(market.market_id),
    allocation: market.allocation,
    activeLps: market.active_lps,
    baseShare: market.base_share,
    bonusShare: market.bonus_share,
    raw: market,
  }));
}
