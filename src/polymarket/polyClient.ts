import type { PolyConfig } from "./polyConfig.js";
import type {
  PolyBookLevel,
  PolyMarket,
  PolyOrderbook,
  PolyRewardInfo,
  PolyToken,
} from "./polyTypes.js";

type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return fallback;
}

function toBooleanOptional(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return undefined;
}

function toNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function inferLifecycle(
  input: Record<string, unknown>,
  now = new Date(),
): {
  active: boolean;
  closed: boolean;
  isResolved: boolean;
  isLive: boolean;
  endDate?: string;
} {
  const active = toBoolean(input.active, true);
  const closed = toBoolean(input.closed, false);
  const explicitResolved = toBooleanOptional(input.resolved ?? input.isResolved) ?? false;
  const endDate = toNonEmptyString(input.end_date ?? input.endDate ?? input.endDateIso);
  const parsedEndDate = toDate(endDate);
  const endedByTime = parsedEndDate !== undefined && parsedEndDate.getTime() <= now.getTime();
  const isResolved = explicitResolved || closed || endedByTime;
  const isLive = !isResolved && active && !closed;
  return { active, closed, isResolved, isLive, endDate };
}

function parseJsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseTokens(input: Record<string, unknown>): PolyToken[] {
  const tokens = input.tokens;
  if (Array.isArray(tokens) && tokens.length > 0) {
    const parsed: PolyToken[] = [];
    for (const token of tokens) {
      if (!token || typeof token !== "object") continue;
      const entry = token as Record<string, unknown>;
      const tokenId = toNonEmptyString(entry.token_id) ?? toNonEmptyString(entry.tokenId);
      const outcome = toNonEmptyString(entry.outcome);
      if (!tokenId || !outcome) continue;
      parsed.push({ tokenId, outcome, price: toNumber(entry.price) });
    }
    return parsed;
  }

  const tokenIds = parseJsonStringArray(input.clobTokenIds ?? input.clob_token_ids);
  const outcomes = parseJsonStringArray(input.outcomes);
  const prices = parseJsonStringArray(input.outcomePrices ?? input.outcome_prices).map((value) =>
    Number.parseFloat(value),
  );
  return tokenIds.map((tokenId, index) => ({
    tokenId,
    outcome: outcomes[index] ?? (index === 0 ? "YES" : "NO"),
    price: Number.isFinite(prices[index]) ? prices[index] : undefined,
  }));
}

function parseRewardInfo(input: Record<string, unknown>): PolyRewardInfo {
  const rewardsConfig = input.rewards_config;
  const ratePerDayUsd =
    Array.isArray(rewardsConfig) &&
    rewardsConfig.length > 0 &&
    rewardsConfig[0] &&
    typeof rewardsConfig[0] === "object"
      ? toNumber((rewardsConfig[0] as Record<string, unknown>).rate_per_day)
      : undefined;
  const rewardsMaxSpreadRaw = toNumber(input.rewards_max_spread ?? input.rewardsMaxSpread);
  const rewardsMaxSpreadCents =
    rewardsMaxSpreadRaw !== undefined ? rewardsMaxSpreadRaw * 100 : undefined;
  const rewardsMinSize = toNumber(input.rewards_min_size ?? input.rewardsMinSize);
  const totalRewardsUsd =
    Array.isArray(rewardsConfig) &&
    rewardsConfig.length > 0 &&
    rewardsConfig[0] &&
    typeof rewardsConfig[0] === "object"
      ? toNumber((rewardsConfig[0] as Record<string, unknown>).total_rewards)
      : undefined;
  return {
    isRewardMarket:
      rewardsMinSize !== undefined ||
      rewardsMaxSpreadCents !== undefined ||
      ratePerDayUsd !== undefined ||
      totalRewardsUsd !== undefined,
    rewardsMinSize,
    rewardsMaxSpreadCents,
    competitiveness: toNumber(input.market_competitiveness ?? input.competitive),
    ratePerDayUsd,
    totalRewardsUsd,
  };
}

function buildMarket(
  input: Record<string, unknown>,
  source: PolyMarket["source"],
): PolyMarket | undefined {
  const conditionId = toNonEmptyString(input.condition_id ?? input.conditionId);
  if (!conditionId) return undefined;
  const title = toNonEmptyString(input.question) ?? toNonEmptyString(input.title);
  if (!title) return undefined;
  const tokens = parseTokens(input);
  if (tokens.length === 0) return undefined;
  const lifecycle = inferLifecycle(input);
  return {
    id: toNonEmptyString(input.market_id ?? input.id) ?? conditionId,
    conditionId,
    marketId: toNonEmptyString(input.market_id ?? input.id),
    eventId: toNonEmptyString(input.event_id),
    eventSlug: toNonEmptyString(input.event_slug ?? input.slug),
    marketSlug: toNonEmptyString(input.market_slug ?? input.slug),
    title,
    active: lifecycle.active,
    closed: lifecycle.closed,
    isLive: lifecycle.isLive,
    isResolved: lifecycle.isResolved,
    endDate: lifecycle.endDate,
    volume24h: toNumber(input.volume_24hr ?? input.volume24hr),
    liquidity: toNumber(input.liquidity ?? input.liquidityClob),
    spread: toNumber(input.spread),
    tokens,
    reward: parseRewardInfo(input),
    source,
    raw: input,
  };
}

function parseLevels(value: unknown): PolyBookLevel[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((level) => {
      if (!level || typeof level !== "object") return undefined;
      const entry = level as Record<string, unknown>;
      const price = toNumber(entry.price);
      const size = toNumber(entry.size ?? entry.amount);
      if (price === undefined || size === undefined || price <= 0 || size <= 0) return undefined;
      return { price, size };
    })
    .filter((level): level is PolyBookLevel => Boolean(level));
}

async function fetchJson<T>(url: string, init?: FetchInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} for ${url}: ${body}`);
  }
  return response.json() as Promise<T>;
}

export class PolyClient {
  constructor(private readonly config: PolyConfig) {}

  async getRewardMarkets(): Promise<PolyMarket[]> {
    const markets: PolyMarket[] = [];
    let cursor: string | undefined;
    while (markets.length < this.config.maxMarketsPerScan) {
      const params = new URLSearchParams({
        page_size: "100",
        order_by: "rate_per_day",
        position: "DESC",
      });
      if (cursor) params.set("next_cursor", cursor);
      const url = `${this.config.clobBaseUrl}/rewards/markets/multi?${params.toString()}`;
      const payload = await fetchJson<{ data?: unknown[]; next_cursor?: string }>(url);
      const page = (payload.data ?? [])
        .map((row) =>
          row && typeof row === "object"
            ? buildMarket(row as Record<string, unknown>, "rewards")
            : undefined,
        )
        .filter((market): market is PolyMarket => Boolean(market));
      markets.push(...page);
      cursor = payload.next_cursor;
      if (!cursor || cursor === "LTE=" || page.length === 0) break;
    }
    return markets.slice(0, this.config.maxMarketsPerScan);
  }

  async getLiveMarkets(): Promise<PolyMarket[]> {
    const markets: PolyMarket[] = [];
    let offset = 0;
    const pageSize = 100;
    while (markets.length < this.config.maxMarketsPerScan) {
      const params = new URLSearchParams({
        active: "true",
        closed: "false",
        limit: String(pageSize),
        offset: String(offset),
      });
      const url = `${this.config.gammaBaseUrl}/events?${params.toString()}`;
      const events = await fetchJson<unknown[]>(url);
      if (!Array.isArray(events) || events.length === 0) break;
      for (const event of events) {
        if (!event || typeof event !== "object") continue;
        const eventRecord = event as Record<string, unknown>;
        const eventId = toNonEmptyString(eventRecord.id);
        const eventSlug = toNonEmptyString(eventRecord.slug);
        const eventMarkets = eventRecord.markets;
        if (!Array.isArray(eventMarkets)) continue;
        for (const market of eventMarkets) {
          if (!market || typeof market !== "object") continue;
          const entry = market as Record<string, unknown>;
          const built = buildMarket(
            {
              ...entry,
              event_id: eventId,
              event_slug: eventSlug,
              volume_24hr: entry.volume24hr,
              market_id: entry.id,
              market_slug: entry.slug,
            },
            "gamma",
          );
          if (built) markets.push(built);
          if (markets.length >= this.config.maxMarketsPerScan) break;
        }
        if (markets.length >= this.config.maxMarketsPerScan) break;
      }
      if (events.length < pageSize) break;
      offset += pageSize;
    }
    return markets.slice(0, this.config.maxMarketsPerScan);
  }

  async getOrderbook(tokenId: string): Promise<PolyOrderbook> {
    const tryUrls = [
      `${this.config.clobBaseUrl}/book?token_id=${encodeURIComponent(tokenId)}`,
      `${this.config.clobBaseUrl}/book?asset_id=${encodeURIComponent(tokenId)}`,
    ];
    for (const url of tryUrls) {
      try {
        const payload = await fetchJson<Record<string, unknown>>(url);
        const bids = parseLevels(payload.bids);
        const asks = parseLevels(payload.asks);
        const bestBid = bids.length > 0 ? Math.max(...bids.map((level) => level.price)) : undefined;
        const bestAsk = asks.length > 0 ? Math.min(...asks.map((level) => level.price)) : undefined;
        const spread =
          bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : undefined;
        return {
          tokenId,
          bids,
          asks,
          bestBid,
          bestAsk,
          midpoint:
            bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : undefined,
          spread,
          source: "clob_rest",
          raw: payload,
        };
      } catch {
        // Try next endpoint variant.
      }
    }
    return { tokenId, bids: [], asks: [], source: "unavailable" };
  }

  async getOrderbooks(tokenIds: string[]): Promise<Map<string, PolyOrderbook>> {
    const unique = [...new Set(tokenIds)].slice(0, this.config.scanOrderbookLimit);
    const map = new Map<string, PolyOrderbook>();
    const concurrency = 8;
    for (let i = 0; i < unique.length; i += concurrency) {
      const batch = unique.slice(i, i + concurrency);
      const books = await Promise.all(batch.map((tokenId) => this.getOrderbook(tokenId)));
      for (const book of books) map.set(book.tokenId, book);
    }
    return map;
  }
}
