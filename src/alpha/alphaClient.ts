import { AlphaClient, type Market, type MarketOption, type OpenOrder, type WalletPosition } from "@alpha-arcade/sdk";
import algosdk from "algosdk";

import type { AlphaConfig } from "./alphaConfig.js";
import { POOL_FALLBACK_DAILY_REWARD_SOURCE, type AlphaBookLevel, type AlphaMarket, type AlphaOrderbook, type AlphaRewardInfo } from "./alphaTypes.js";

const MICRO = 1_000_000;
const ALPHA_API_HOST = "alphaarcade.com";
const MAX_ERROR_BODY_LOG_CHARS = 800;
let alphaApiDiagnosticsInstalled = false;

type AlphaRuntimeClient = AlphaClient & {
  createMarketOrder?: (input: {
    marketAppId: number;
    position: 0 | 1;
    price: number;
    quantity: number;
    isBuying: boolean;
    slippage: number;
  }) => Promise<{ escrowAppId?: number; txIds?: string[]; confirmedRound?: number; matchedQuantity?: number; actualFillPrice?: number }>;
  mergeShares?: (input: { marketAppId: number; amount: number }) => Promise<{ txIds?: string[]; confirmedRound?: number }>;
  splitShares?: (input: { marketAppId: number; amount: number }) => Promise<{ txIds?: string[]; confirmedRound?: number }>;
  claim?: (input: { marketAppId: number; assetId: number; amount?: number }) => Promise<{
    success?: boolean;
    txIds?: string[];
    confirmedRound?: number;
    amountClaimed?: number;
  }>;
};

export type MarketChainStatus = {
  isResolved?: boolean;
  isActivated?: boolean;
  outcome?: number;
};

export function fromMicroUnits(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
  return value / MICRO;
}

export function toMicroUnits(value: number): number {
  return Math.max(0, Math.floor(value * MICRO));
}

export function roundShares(value: number): number {
  return Math.floor(value * MICRO) / MICRO;
}

function normalizeApiPrice(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  if (value > 1) return value / MICRO;
  if (value < 0 || value > 1) return undefined;
  return value;
}

function normalizeUsd(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value > 10_000 ? value / MICRO : value;
}

function normalizeMarketVolumeUsd(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value > 10_000_000 ? value / MICRO : value;
}

function normalizeRewardSpreadCents(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  if (value > 10_000) return (value / MICRO) * 100;
  if (value > 100) return value / 10_000;
  if (value <= 1) return value * 100;
  return value;
}

function normalizeContracts(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value > 10_000 ? value / MICRO : value;
}

function inferCompetition(market: Market | MarketOption): AlphaRewardInfo["competitionLevel"] {
  const raw = market.competitionLevel;
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  return "unknown";
}

function hasPositiveRewardSignal(market: Market | MarketOption): boolean {
  const looseMarket = market as (Market | MarketOption) & Record<string, unknown>;
  return [market.totalRewards, market.rewardsPaidOut, looseMarket.dailyRewards, looseMarket.dailyReward, looseMarket.rewardPerDay].some(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
}

/**
 * Resolve a per-day reward figure, preferring genuine daily fields. The API
 * does not always expose one; the legacy behaviour fell back to `totalRewards`
 * (the whole pool) as if it were a daily number, which materially overstates
 * the reward rate. We still allow that as a last resort but tag the source so
 * the overstatement is visible, and it can be calibrated out downstream.
 */
function resolveDailyReward(looseMarket: Record<string, unknown>): { usd?: number; source: string } {
  const dailyCandidates: Array<[string, unknown]> = [
    ["dailyRewards", looseMarket.dailyRewards],
    ["dailyReward", looseMarket.dailyReward],
    ["rewardPerDay", looseMarket.rewardPerDay],
  ];
  for (const [source, raw] of dailyCandidates) {
    const usd = normalizeUsd(raw);
    if (usd !== undefined && usd > 0) return { usd, source };
  }
  const poolUsd = normalizeUsd(looseMarket.totalRewards);
  if (poolUsd !== undefined && poolUsd > 0) return { usd: poolUsd, source: POOL_FALLBACK_DAILY_REWARD_SOURCE };
  return { source: "none" };
}

function toRewardInfo(market: Market | MarketOption, fallback?: Market): AlphaRewardInfo {
  const rewardSource = !hasPositiveRewardSignal(market) && fallback && hasPositiveRewardSignal(fallback) ? fallback : market;
  const looseMarket = rewardSource as (Market | MarketOption) & Record<string, unknown>;
  const totalRewardsUsd = normalizeUsd(rewardSource.totalRewards);
  const rewardsPaidOutUsd = normalizeUsd(rewardSource.rewardsPaidOut);
  const remainingRewardsUsd =
    totalRewardsUsd !== undefined && rewardsPaidOutUsd !== undefined
      ? Math.max(0, totalRewardsUsd - rewardsPaidOutUsd)
      : undefined;
  const dailyReward = resolveDailyReward(looseMarket);
  return {
    isRewardMarket: hasPositiveRewardSignal(rewardSource),
    totalRewardsUsd,
    rewardsPaidOutUsd,
    remainingRewardsUsd,
    dailyRewardsUsd: dailyReward.usd,
    dailyRewardsSource: dailyReward.source,
    lastPayoutUsd: normalizeUsd(rewardSource.lastRewardAmount),
    maxRewardSpreadCents: normalizeRewardSpreadCents(rewardSource.rewardsSpreadDistance),
    minContracts: normalizeContracts(rewardSource.rewardsMinContracts),
    competitionLevel: inferCompetition(rewardSource),
  };
}

function toMarketStatus(market: Market): string {
  if (market.isResolved) return "resolved";
  if (market.isLive === false) return "closed";
  return "live";
}

function emptyOrderbook(market: AlphaMarket, source: AlphaOrderbook["source"], raw: unknown): AlphaOrderbook {
  return {
    marketId: market.id,
    marketAppId: market.marketAppId,
    slug: market.slug,
    source,
    yesSideOrders: { bids: [], asks: [] },
    noSideOrders: { bids: [], asks: [] },
    raw,
  };
}

function decodeGlobalKey(rawKey: unknown): string {
  if (typeof rawKey === "string") return Buffer.from(rawKey, "base64").toString();
  if (rawKey instanceof Uint8Array) return Buffer.from(rawKey).toString();
  return String(rawKey);
}

function decodeGlobalUint(rawValue: unknown): number | undefined {
  if (!rawValue || typeof rawValue !== "object") return undefined;
  const value = rawValue as { uint?: number | bigint; type?: number };
  if (value.uint === undefined) return undefined;
  return Number(value.uint);
}

function flattenMarket(market: Market): AlphaMarket[] {
  if (market.options && market.options.length > 0) {
    return market.options.map((option) => {
      const looseOption = option as MarketOption & Record<string, unknown>;
      return {
        id: option.id ?? `${market.id}:${option.marketAppId}`,
        marketAppId: option.marketAppId,
        slug: market.slug,
        title: `${market.title} - ${option.title ?? looseOption.label ?? option.id}`,
        category: market.categories?.[0],
        status: toMarketStatus(market),
        closeTime: market.endTs ? new Date(market.endTs * 1000).toISOString() : undefined,
        endTs: market.endTs,
        resolved: Boolean(market.isResolved),
        yesPrice: normalizeApiPrice(option.yesProb),
        noPrice: normalizeApiPrice(option.noProb),
        volume: normalizeMarketVolumeUsd(looseOption.volume ?? market.volume),
        reward: toRewardInfo(option, market),
        raw: { market, option },
      };
    });
  }
  return [
    {
      id: market.id,
      marketAppId: market.marketAppId,
      slug: market.slug,
      title: market.title,
      category: market.categories?.[0],
      status: toMarketStatus(market),
      closeTime: market.endTs ? new Date(market.endTs * 1000).toISOString() : undefined,
      endTs: market.endTs,
      resolved: Boolean(market.isResolved),
      yesPrice: normalizeApiPrice(market.yesProb),
      noPrice: normalizeApiPrice(market.noProb),
      volume: normalizeMarketVolumeUsd(market.volume),
      reward: toRewardInfo(market),
      raw: market,
    },
  ];
}

function bestBid(levels: AlphaBookLevel[]): number | undefined {
  return levels.length > 0 ? Math.max(...levels.map((level) => level.price)) : undefined;
}

function bestAsk(levels: AlphaBookLevel[]): number | undefined {
  return levels.length > 0 ? Math.min(...levels.map((level) => level.price)) : undefined;
}

function normalizeLevels(entries: Array<{ price: number; quantity: number; escrowAppId?: number; owner?: string }>): AlphaBookLevel[] {
  return entries
    .map((entry) => ({
      price: fromMicroUnits(entry.price) ?? 0,
      quantityShares: fromMicroUnits(entry.quantity) ?? 0,
      escrowAppId: entry.escrowAppId,
      owner: entry.owner,
    }))
    .filter((entry) => entry.price > 0 && entry.price < 1 && entry.quantityShares > 0);
}

function shortError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function truncateText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

function looksLikeAlphaApiUrl(url: string): boolean {
  try {
    return new URL(url).hostname.includes(ALPHA_API_HOST);
  } catch {
    return url.includes(ALPHA_API_HOST);
  }
}

function installAlphaApiDiagnostics(): void {
  if (alphaApiDiagnosticsInstalled) return;
  if (typeof globalThis.fetch !== "function") return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    const isAlphaApi = looksLikeAlphaApiUrl(url);

    try {
      const response = await originalFetch(input, init);
      if (isAlphaApi && !response.ok) {
        let bodyPreview = "";
        try {
          const responseBody = await response.clone().text();
          bodyPreview = responseBody ? truncateText(responseBody, MAX_ERROR_BODY_LOG_CHARS) : "<empty body>";
        } catch {
          bodyPreview = "<failed to read response body>";
        }
        console.error(
          `[ghillie-api] ${method} ${url} -> ${response.status} ${response.statusText} | body=${bodyPreview}`,
        );
      }
      return response;
    } catch (error) {
      if (isAlphaApi) {
        console.error(`[ghillie-api] ${method} ${url} -> request failed: ${shortError(error)}`);
      }
      throw error;
    }
  }) as typeof globalThis.fetch;
  alphaApiDiagnosticsInstalled = true;
}

export class AlphaSdkClient {
  private readonly client: AlphaClient;
  private readonly algodClient: algosdk.Algodv2;
  private readonly usdcAssetId: number;

  constructor(config: AlphaConfig, liveSigner: boolean) {
    installAlphaApiDiagnostics();
    const account =
      liveSigner && config.walletMnemonic ? algosdk.mnemonicToSecretKey(config.walletMnemonic) : algosdk.generateAccount();
    this.algodClient = new algosdk.Algodv2(config.algodToken ?? "", config.algodServer, "");
    this.usdcAssetId = config.usdcAssetId;
    this.client = new AlphaClient({
      apiKey: config.apiKey,
      algodClient: this.algodClient,
      indexerClient: new algosdk.Indexer(config.algodToken ?? "", config.indexerServer, ""),
      signer: algosdk.makeBasicAccountTransactionSigner(account),
      activeAddress: liveSigner && config.walletAddress ? config.walletAddress : account.addr.toString(),
      matcherAppId: config.matcherAppId,
      usdcAssetId: config.usdcAssetId,
    });
  }

  async getLiveMarkets(): Promise<AlphaMarket[]> {
    try {
      const markets = await this.client.getLiveMarkets();
      return markets.flatMap(flattenMarket);
    } catch (error) {
      throw new Error(`Failed to fetch live markets from Alpha API: ${shortError(error)}`);
    }
  }

  async getRewardMarkets(): Promise<AlphaMarket[]> {
    try {
      const markets = await this.client.getRewardMarkets();
      return markets.flatMap(flattenMarket).filter((market) => market.reward.isRewardMarket);
    } catch (error) {
      throw new Error(`Failed to fetch reward markets from Alpha API: ${shortError(error)}`);
    }
  }

  async getMarket(marketIdOrSlug: string): Promise<AlphaMarket | undefined> {
    const markets = await this.getLiveMarkets();
    return markets.find((market) => market.id === marketIdOrSlug || market.slug === marketIdOrSlug || String(market.marketAppId) === marketIdOrSlug);
  }

  async getMarketResolution(marketAppId: number): Promise<MarketChainStatus> {
    return this.getMarketChainStatus(marketAppId);
  }

  private async getMarketChainStatus(marketAppId: number): Promise<MarketChainStatus> {
    try {
      const app = (await this.algodClient.getApplicationByID(marketAppId).do()) as {
        params?: {
          globalState?: Array<{ key: unknown; value: unknown }>;
          "global-state"?: Array<{ key: unknown; value: unknown }>;
        };
      };
      const globalState = app.params?.globalState ?? app.params?.["global-state"] ?? [];
      const status: MarketChainStatus = {};
      for (const entry of globalState) {
        const key = decodeGlobalKey(entry.key);
        if (key === "is_resolved") status.isResolved = decodeGlobalUint(entry.value) === 1;
        if (key === "is_activated") status.isActivated = decodeGlobalUint(entry.value) === 1;
        if (key === "outcome") status.outcome = decodeGlobalUint(entry.value);
      }
      return status;
    } catch {
      return {};
    }
  }

  async getOrderbook(market: AlphaMarket): Promise<AlphaOrderbook> {
    try {
      const chainStatus = await this.getMarketChainStatus(market.marketAppId);
      if (chainStatus.isResolved || chainStatus.isActivated === false) {
        return emptyOrderbook(market, "unavailable", { reason: "market is not live on-chain", chainStatus });
      }
      const book = await this.client.getOrderbook(market.marketAppId);
      const yesBids = normalizeLevels(book.yes.bids);
      const yesAsks = normalizeLevels(book.yes.asks);
      const noBids = normalizeLevels(book.no.bids);
      const noAsks = normalizeLevels(book.no.asks);
      const yesBid = bestBid(yesBids);
      const yesAsk = bestAsk(yesAsks);
      const noBid = bestBid(noBids);
      const noAsk = bestAsk(noAsks);
      const yesSpread = yesBid !== undefined && yesAsk !== undefined ? yesAsk - yesBid : undefined;
      const noSpread = noBid !== undefined && noAsk !== undefined ? noAsk - noBid : undefined;
      return {
        marketId: market.id,
        marketAppId: market.marketAppId,
        slug: market.slug,
        source: "onchain_orderbook",
        yesBid,
        yesAsk,
        noBid,
        noAsk,
        yesMid: yesBid !== undefined && yesAsk !== undefined ? (yesBid + yesAsk) / 2 : market.yesPrice,
        noMid: noBid !== undefined && noAsk !== undefined ? (noBid + noAsk) / 2 : market.noPrice,
        yesSpread,
        noSpread,
        bestSpread: Math.max(yesSpread ?? 0, noSpread ?? 0) || undefined,
        yesSideOrders: { bids: yesBids, asks: yesAsks },
        noSideOrders: { bids: noBids, asks: noAsks },
        raw: book,
      };
    } catch (error) {
      return emptyOrderbook(market, "unavailable", error);
    }
  }

  async getPositions(walletAddress?: string): Promise<WalletPosition[]> {
    return this.client.getPositions(walletAddress);
  }

  async getOpenOrders(marketAppId: number, walletAddress?: string): Promise<OpenOrder[]> {
    return this.client.getOpenOrders(marketAppId, walletAddress);
  }

  async getWalletOpenOrders(walletAddress: string): Promise<OpenOrder[]> {
    try {
      return this.client.getWalletOrdersFromApi(walletAddress);
    } catch (error) {
      throw new Error(`Failed to fetch wallet open orders from Alpha API for ${walletAddress}: ${shortError(error)}`);
    }
  }

  async getUsdcBalance(walletAddress: string): Promise<number | undefined> {
    try {
      const result = (await this.algodClient.accountAssetInformation(walletAddress, this.usdcAssetId).do()) as {
        assetHolding?: { amount?: number | bigint };
        assetHoldingInfo?: { amount?: number | bigint };
        amount?: number | bigint;
      };
      const amount = result.assetHolding?.amount ?? result.assetHoldingInfo?.amount ?? result.amount;
      if (amount === undefined) return 0;
      return Number(amount) / MICRO;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch USDC balance for ${walletAddress}: ${message}`);
    }
  }

  async getAlgoBalance(walletAddress: string): Promise<number | undefined> {
    try {
      const result = (await this.algodClient.accountInformation(walletAddress).do()) as {
        amount?: number | bigint;
      };
      if (result.amount === undefined) return 0;
      return Number(result.amount) / MICRO;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch ALGO balance for ${walletAddress}: ${message}`);
    }
  }

  async createLimitOrder(_input: {
    marketAppId: number;
    outcome: "YES" | "NO";
    price: number;
    sizeShares: number;
    isBuying: boolean;
  }): Promise<{
    escrowAppId: number;
    txIds: string[];
    confirmedRound: number;
    matchedQuantity?: number;
    matchedPrice?: number;
  }> {
    throw new Error(
      "createLimitOrder via Alpha SDK is disabled; place limit orders through Amarok MCP (amarok_get_execution_quote) + local sign/submit",
    );
  }

  async createMarketOrder(input: {
    marketAppId: number;
    outcome: "YES" | "NO";
    price: number;
    sizeShares: number;
    isBuying: boolean;
    slippage: number;
  }): Promise<{ escrowAppId?: number; txIds: string[]; confirmedRound?: number; matchedQuantity?: number; actualFillPrice?: number }> {
    const runtimeClient = this.client as AlphaRuntimeClient;
    if (!runtimeClient.createMarketOrder) throw new Error("Alpha SDK does not expose createMarketOrder");
    const result = await runtimeClient.createMarketOrder({
      marketAppId: input.marketAppId,
      position: input.outcome === "YES" ? 1 : 0,
      price: toMicroUnits(input.price),
      quantity: toMicroUnits(input.sizeShares),
      isBuying: input.isBuying,
      slippage: toMicroUnits(input.slippage),
    });
    const looseResult = result as typeof result & { matchedQuantity?: number; actualFillPrice?: number };
    return {
      ...looseResult,
      txIds: looseResult.txIds ?? [],
      matchedQuantity: fromMicroUnits(looseResult.matchedQuantity),
      actualFillPrice: fromMicroUnits(looseResult.actualFillPrice),
    };
  }

  async mergeShares(input: { marketAppId: number; amountShares: number }): Promise<{ txIds: string[]; confirmedRound?: number }> {
    const runtimeClient = this.client as AlphaRuntimeClient;
    if (!runtimeClient.mergeShares) throw new Error("Alpha SDK does not expose mergeShares");
    const result = await runtimeClient.mergeShares({
      marketAppId: input.marketAppId,
      amount: toMicroUnits(input.amountShares),
    });
    return { ...result, txIds: result.txIds ?? [] };
  }

  async splitShares(input: { marketAppId: number; amountUsd: number }): Promise<{ txIds: string[]; confirmedRound?: number }> {
    const runtimeClient = this.client as AlphaRuntimeClient;
    if (!runtimeClient.splitShares) throw new Error("Alpha SDK does not expose splitShares");
    const result = await runtimeClient.splitShares({
      marketAppId: input.marketAppId,
      amount: toMicroUnits(input.amountUsd),
    });
    return { ...result, txIds: result.txIds ?? [] };
  }

  async claim(input: {
    marketAppId: number;
    assetId: number;
    amountShares?: number;
  }): Promise<{ success: boolean; txIds: string[]; confirmedRound?: number; amountClaimedShares?: number }> {
    const runtimeClient = this.client as AlphaRuntimeClient;
    if (!runtimeClient.claim) throw new Error("Alpha SDK does not expose claim");
    const result = await runtimeClient.claim({
      marketAppId: input.marketAppId,
      assetId: input.assetId,
      amount: input.amountShares === undefined ? undefined : toMicroUnits(input.amountShares),
    });
    return {
      success: result.success ?? true,
      txIds: result.txIds ?? [],
      confirmedRound: result.confirmedRound,
      amountClaimedShares: fromMicroUnits(result.amountClaimed),
    };
  }

  async cancelOrder(input: { marketAppId: number; escrowAppId: number; orderOwner: string }): Promise<{ success: boolean }> {
    return this.client.cancelOrder(input);
  }
}
