import {
  type AmarokScanCompleteness,
  marketFromAmarok,
  orderbookFromAmarok,
  scanFromAmarok,
} from "../integrations/amarok/adapters.js";
import type { AmarokClient, ManagedToolResult } from "../integrations/amarok/client.js";
import type { PaymentReceipt } from "../integrations/amarok/payment.js";
import { createAmarokRuntime } from "../integrations/amarok/runtime.js";
import { loadOperatorPreferencesFromEnv } from "../integrations/storage/operatorPreferences.js";
import { isDebugModeEnabled } from "../utils/debugMode.js";
import type { AlphaConfig, AmarokResearchSku } from "./alphaConfig.js";
import type { AlphaMarket, AlphaOrderbook } from "./alphaTypes.js";

function logStartupDebug(message: string): void {
  if (!isDebugModeEnabled()) return;
  console.log(`[startup-debug ${new Date().toISOString()}] [scan] ${message}`);
}

export type AlphaResearchMode = "legacy" | "lane";

export type AlphaScanResult = {
  markets: AlphaMarket[];
  rewardMarkets: AlphaMarket[];
  orderbooks: Map<number, AlphaOrderbook>;
  rewardError?: string;
  /** x402 receipts from Amarok research calls during this scan (when paid). */
  payments?: PaymentReceipt[];
  /** Host research path: lane MCP tools when operator prefs are present. */
  researchMode?: AlphaResearchMode;
  /** Trimmed operator prefs when present (reuse for plan-review). */
  operatorPreferences?: string;
  /** Amarok 1.4.0+ scan partial-result flags (absent on older payloads). */
  scanCompleteness?: AmarokScanCompleteness;
  /** Which research SKU path was used for covered GETs this tick. */
  researchSku?: "per-request" | "bundle" | "session";
};

function isLiveMarket(market: AlphaMarket): boolean {
  return !market.resolved && market.status === "live";
}

function parseOptionalLimit(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  if (normalized <= 0) return undefined;
  return normalized;
}

function collectPayments(...results: Array<ManagedToolResult | undefined>): PaymentReceipt[] {
  return results
    .map((result) => result?.payment)
    .filter((payment): payment is PaymentReceipt => payment !== undefined);
}

async function hasAmarokTool(client: AmarokClient, toolName: string): Promise<boolean> {
  try {
    const tools = await client.listTools();
    return tools.some((tool) => tool.name === toolName);
  } catch {
    return false;
  }
}

function resolveRequestedSku(
  configSku: AmarokResearchSku,
  researchMode: AlphaResearchMode,
): "off" | "bundle" | "session" {
  if (configSku === "off") return "off";
  // Bundle returns mixed opportunities — only valid as a legacy quotes+opps substitute.
  if (configSku === "bundle") return researchMode === "legacy" ? "bundle" : "off";
  // Session amortizes covered GETs (quotes + lanes) within one tick.
  if (configSku === "session") return researchMode === "lane" ? "session" : "off";
  return "off";
}

export type LoadAlphaScanOptions = {
  /** Injected for tests — replaces Spaces/local prefs load. */
  loadOperatorPreferences?: () => Promise<string | undefined>;
  /** Injected for tests — replaces createAmarokRuntime. */
  createRuntime?: (config: AlphaConfig) => ReturnType<typeof createAmarokRuntime>;
};

/**
 * Load Alpha market intel exclusively via Amarok remote MCP (paid x402).
 * Non-empty operator preferences switch research off mixed opportunities onto lane tools.
 */
export async function loadAlphaScan(
  config: AlphaConfig,
  options: LoadAlphaScanOptions = {},
): Promise<AlphaScanResult> {
  const startedAt = Date.now();
  logStartupDebug(
    `loadAlphaScan start maxMarketsPerScan=${config.maxMarketsPerScan} mcp=${config.amarokMcpUrl} researchSku=${config.amarokResearchSku}`,
  );

  if (!config.walletAddress) {
    throw new Error("ALPHA_WALLET_ADDRESS or ALPHA_WALLET_MNEMONIC is required for Amarok scan");
  }

  const operatorPreferences = (
    options.loadOperatorPreferences
      ? await options.loadOperatorPreferences()
      : await loadOperatorPreferencesFromEnv()
  )?.trim();
  const researchMode: AlphaResearchMode = operatorPreferences ? "lane" : "legacy";
  const requestedSku = resolveRequestedSku(config.amarokResearchSku, researchMode);

  const runtime = (options.createRuntime ?? createAmarokRuntime)(config);
  try {
    const scanArgs: Record<string, unknown> = {};
    const maxMarketsPerScan = parseOptionalLimit(config.maxMarketsPerScan);
    if (maxMarketsPerScan) scanArgs.limit = maxMarketsPerScan;
    const limitArgs = maxMarketsPerScan ? { limit: maxMarketsPerScan } : {};

    // Scan is always per-request (not session/bundle covered).
    const scanResult = await runtime.client.getScan(config.walletAddress, scanArgs);

    let quotesResult: ManagedToolResult | undefined;
    let opportunitiesResult: ManagedToolResult | undefined;
    let rewardsResult: ManagedToolResult | undefined;
    let spreadsResult: ManagedToolResult | undefined;
    let parityResult: ManagedToolResult | undefined;
    let bundleResult: ManagedToolResult | undefined;
    let sessionResult: ManagedToolResult | undefined;
    let researchSku: "per-request" | "bundle" | "session" = "per-request";
    const toolsCalled = ["amarok_get_scan"];

    if (requestedSku === "bundle") {
      const bundleAvailable = await hasAmarokTool(runtime.client, "amarok_get_research_bundle");
      if (bundleAvailable) {
        const marketLimit = Math.min(Math.max(maxMarketsPerScan ?? 5, 1), 10);
        try {
          bundleResult = await runtime.client.getResearchBundle(config.walletAddress, {
            ...limitArgs,
            marketLimit,
          });
          researchSku = "bundle";
          toolsCalled.push("amarok_get_research_bundle");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logStartupDebug(`bundle SKU failed; falling back to per-request: ${message}`);
          console.warn(`[scan] Amarok bundle failed; falling back to per-request: ${message}`);
        }
      } else {
        logStartupDebug("bundle SKU requested but amarok_get_research_bundle missing; per-request");
      }
    }

    if (researchSku === "per-request" && requestedSku === "session") {
      const sessionAvailable = await hasAmarokTool(
        runtime.client,
        "amarok_create_research_session",
      );
      if (sessionAvailable) {
        try {
          sessionResult = await runtime.client.createResearchSession(config.walletAddress, {
            ttlSeconds: 60,
          });
          researchSku = "session";
          toolsCalled.push("amarok_create_research_session");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logStartupDebug(`session SKU failed; falling back to per-request: ${message}`);
          console.warn(
            `[scan] Amarok session mint failed; falling back to per-request: ${message}`,
          );
        }
      } else {
        logStartupDebug(
          "session SKU requested but amarok_create_research_session missing; per-request",
        );
      }
    }

    if (researchSku === "bundle" && bundleResult) {
      // Bundle already includes opportunities + quotes (+ optional market details).
    } else if (researchMode === "lane") {
      quotesResult = await runtime.client.getQuotes(config.walletAddress, limitArgs);
      toolsCalled.push("amarok_get_quotes");
      if (config.enableRewardLane) {
        rewardsResult = await runtime.client.listRewards(config.walletAddress, limitArgs);
        toolsCalled.push("amarok_list_rewards");
      }
      if (config.enableSpreadLane) {
        spreadsResult = await runtime.client.listSpreads(config.walletAddress, limitArgs);
        toolsCalled.push("amarok_list_spreads");
      }
      if (config.enableParityLane) {
        parityResult = await runtime.client.listParity(config.walletAddress, limitArgs);
        toolsCalled.push("amarok_list_parity");
      }
    } else {
      quotesResult = await runtime.client.getQuotes(config.walletAddress, limitArgs);
      toolsCalled.push("amarok_get_quotes");
      opportunitiesResult = await runtime.client.listOpportunities(config.walletAddress, limitArgs);
      toolsCalled.push("amarok_list_opportunities");
    }

    const payments = collectPayments(
      scanResult,
      sessionResult,
      bundleResult,
      quotesResult,
      opportunitiesResult,
      rewardsResult,
      spreadsResult,
      parityResult,
    );

    const bundleData =
      bundleResult?.data && typeof bundleResult.data === "object"
        ? (bundleResult.data as Record<string, unknown>)
        : undefined;

    const adapted = scanFromAmarok({
      scanPayload: scanResult.data,
      opportunitiesPayload: opportunitiesResult?.data ?? bundleData?.opportunities,
      rewardsPayload: rewardsResult?.data,
      spreadsPayload: spreadsResult?.data,
      parityPayload: parityResult?.data,
      quotesPayload: quotesResult?.data ?? bundleData?.quotes,
      bundleMarketsPayload: bundleData?.markets,
    });

    let markets = adapted.markets.filter(isLiveMarket);
    let rewardMarkets = adapted.rewardMarkets.filter(isLiveMarket);
    logStartupDebug(
      `amarok scan adapted research_mode=${researchMode} research_sku=${researchSku} tools=${toolsCalled.join(",")} markets=${markets.length} rewardMarkets=${rewardMarkets.length} orderbooks=${adapted.orderbooks.size} timedOut=${adapted.scanCompleteness?.timedOut ?? false} orderbookErrors=${adapted.scanCompleteness?.orderbookErrors ?? 0}`,
    );

    const marketsByAppId = new Map<number, AlphaMarket>();
    for (const market of rewardMarkets) marketsByAppId.set(market.marketAppId, market);
    for (const market of markets) marketsByAppId.set(market.marketAppId, market);
    let marketsToScan = [...marketsByAppId.values()];
    if (maxMarketsPerScan && marketsToScan.length > maxMarketsPerScan) {
      marketsToScan = marketsToScan.slice(0, maxMarketsPerScan);
      logStartupDebug(`markets truncated for scan selected=${marketsToScan.length}`);
    }

    const orderbooks = new Map<number, AlphaOrderbook>();
    for (const market of marketsToScan) {
      const book = adapted.orderbooks.get(market.marketAppId);
      if (book) orderbooks.set(market.marketAppId, book);
    }

    markets = marketsToScan;
    rewardMarkets = rewardMarkets.filter((market) =>
      marketsToScan.some((candidate) => candidate.marketAppId === market.marketAppId),
    );

    logStartupDebug(
      `loadAlphaScan end elapsed_ms=${Date.now() - startedAt} research_mode=${researchMode} research_sku=${researchSku} orderbooks=${orderbooks.size} x402_payments=${payments.length}`,
    );
    return {
      markets,
      rewardMarkets,
      orderbooks,
      payments: payments.length > 0 ? payments : undefined,
      researchMode,
      operatorPreferences: operatorPreferences || undefined,
      scanCompleteness: adapted.scanCompleteness,
      researchSku,
    };
  } finally {
    await runtime.close();
  }
}

export async function loadAmarokMarket(
  config: AlphaConfig,
  marketIdOrSlug: string,
): Promise<{
  market: AlphaMarket;
  orderbook: AlphaOrderbook;
}> {
  if (!config.walletAddress) {
    throw new Error(
      "ALPHA_WALLET_ADDRESS or ALPHA_WALLET_MNEMONIC is required for Amarok market lookup",
    );
  }
  const runtime = createAmarokRuntime(config);
  try {
    const asAppId = Number.parseInt(marketIdOrSlug, 10);
    if (Number.isFinite(asAppId) && asAppId > 0) {
      const result = await runtime.client.getMarket(config.walletAddress, asAppId);
      const market = marketFromAmarok((result.data as { data?: unknown })?.data ?? result.data);
      if (!market) throw new Error(`Amarok market not found: ${marketIdOrSlug}`);
      const bookRaw =
        (market.raw as { book?: unknown; orderbook?: unknown } | undefined)?.book ??
        (market.raw as { orderbook?: unknown } | undefined)?.orderbook ??
        {};
      return { market, orderbook: orderbookFromAmarok(market, bookRaw) };
    }

    const scan = await loadAlphaScan(config);
    const market =
      scan.markets.find(
        (candidate) =>
          candidate.id === marketIdOrSlug ||
          candidate.slug === marketIdOrSlug ||
          String(candidate.marketAppId) === marketIdOrSlug,
      ) ??
      scan.rewardMarkets.find(
        (candidate) =>
          candidate.id === marketIdOrSlug ||
          candidate.slug === marketIdOrSlug ||
          String(candidate.marketAppId) === marketIdOrSlug,
      );
    if (!market) throw new Error(`Amarok market not found: ${marketIdOrSlug}`);
    const orderbook = scan.orderbooks.get(market.marketAppId);
    if (!orderbook) throw new Error(`Amarok orderbook missing for market ${market.marketAppId}`);
    return { market, orderbook };
  } finally {
    await runtime.close();
  }
}

export function summarizeBooks(books: Iterable<AlphaOrderbook>): {
  twoSided: number;
  oneSided: number;
  empty: number;
  averageSpread: number;
} {
  let twoSided = 0;
  let oneSided = 0;
  let empty = 0;
  let spreadTotal = 0;
  let spreadCount = 0;
  for (const book of books) {
    const hasBid = book.yesBid !== undefined || book.noBid !== undefined;
    const hasAsk = book.yesAsk !== undefined || book.noAsk !== undefined;
    if (hasBid && hasAsk) twoSided += 1;
    else if (hasBid || hasAsk) oneSided += 1;
    else empty += 1;
    if (book.bestSpread !== undefined) {
      spreadTotal += book.bestSpread;
      spreadCount += 1;
    }
  }
  return {
    twoSided,
    oneSided,
    empty,
    averageSpread: spreadCount > 0 ? spreadTotal / spreadCount : 0,
  };
}
