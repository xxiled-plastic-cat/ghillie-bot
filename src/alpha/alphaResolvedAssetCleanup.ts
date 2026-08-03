/**
 * CLI-only resolved ASA cleanup (claim / close opt-ins).
 *
 * This path does **not** load or save bot state and must never adjust
 * `realisedPnl`. Live tick settlement PnL for resolved free shares belongs
 * solely to `runResolvedClaimLane`. Prefer claim-then-close for dust so the
 * wallet is cleaned without double-counting trading PnL in bot ledgers.
 *
 * Market directory comes from wallet footprint (positions + open orders) plus
 * live markets for slug enrichment — not a persisted market-status table.
 */
import algosdk from "algosdk";
import type { OpenOrder, WalletPosition } from "@alpha-arcade/sdk";

import { readAlphaConfig } from "./alphaConfig.js";
import { AlphaSdkClient, fromMicroUnits } from "./alphaClient.js";
import type { AlphaMarket } from "./alphaTypes.js";

type CleanupOptions = {
  execute: boolean;
  limit?: number;
};

type KnownAlphaMarket = {
  marketAppId: number;
  marketId: string | null;
  slug: string | null;
  isResolved: boolean;
  isLive: boolean;
  isClosed: boolean;
};

type AccountAssetHolding = {
  assetId: number;
  amount: bigint;
};

type MatchedAssetHolding = {
  market: KnownAlphaMarket;
  marketCreatorAddress: string;
  assetId: number;
  amount: bigint;
};

type CleanupSummary = {
  dryRun: boolean;
  walletAddress: string;
  resolvedMarkets: number;
  walletAssetHoldings: number;
  matchedHoldings: number;
  attemptedCloseOuts: number;
  successfulCloseOuts: number;
  skippedForActiveBids: number;
};

type AccountInfoResponse = {
  assets?: Array<{
    "asset-id"?: number | bigint;
    assetId?: number | bigint;
    amount?: number | bigint;
  }>;
};

type AssetInfoResponse = {
  params?: { creator?: string };
  asset?: { params?: { creator?: string } };
};

function parseCliAmount(value: number | bigint | undefined): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.floor(value));
  return 0n;
}

function parseAssetId(value: number | bigint | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : undefined;
  }
  return undefined;
}

function normalizeWalletAssetHoldings(accountInfo: AccountInfoResponse): AccountAssetHolding[] {
  const assets = Array.isArray(accountInfo.assets) ? accountInfo.assets : [];
  const holdings: AccountAssetHolding[] = [];
  for (const holding of assets) {
    const assetId = parseAssetId(holding["asset-id"] ?? holding.assetId);
    if (assetId === undefined) continue;
    holdings.push({
      assetId,
      amount: parseCliAmount(holding.amount),
    });
  }
  return holdings;
}

function formatMarketLabel(market: Pick<KnownAlphaMarket, "marketAppId" | "marketId" | "slug">): string {
  if (market.slug) return `${market.slug} (${market.marketAppId})`;
  if (market.marketId) return `${market.marketId} (${market.marketAppId})`;
  return String(market.marketAppId);
}

function printSummary(summary: CleanupSummary): void {
  console.log("NUCKELAVEE ALPHA RESOLVED ASSET CLEANUP");
  console.log("");
  console.log(`Mode: ${summary.dryRun ? "dry-run" : "execute"}`);
  console.log(`Wallet: ${summary.walletAddress}`);
  console.log(`Resolved markets: ${summary.resolvedMarkets}`);
  console.log(`Wallet ASA holdings scanned: ${summary.walletAssetHoldings}`);
  console.log(`Matched market-created holdings: ${summary.matchedHoldings}`);
  console.log(`Attempted close-outs: ${summary.attemptedCloseOuts}`);
  console.log(`Successful close-outs: ${summary.successfulCloseOuts}`);
  console.log(`Skipped (active bids): ${summary.skippedForActiveBids}`);
}

async function resolveHoldingCreator(
  algod: algosdk.Algodv2,
  holding: AccountAssetHolding,
): Promise<string | undefined> {
  try {
    const assetInfo = (await algod.getAssetByID(holding.assetId).do()) as AssetInfoResponse;
    const creator = assetInfo.params?.creator ?? assetInfo.asset?.params?.creator;
    return typeof creator === "string" && creator.length > 0 ? creator : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404") || message.toLowerCase().includes("asset does not exist")) {
      return undefined;
    }
    throw error;
  }
}

function resolveWalletAddressAndSigner(): { walletAddress: string; signer: algosdk.Account } {
  const config = readAlphaConfig();
  const mnemonic = (config.walletMnemonic ?? "").trim();
  if (!mnemonic) {
    throw new Error("Resolved asset cleanup requires ALPHA_WALLET_MNEMONIC.");
  }

  const signer = algosdk.mnemonicToSecretKey(mnemonic);
  const signerAddress = signer.addr.toString();
  const walletAddress = (config.walletAddress ?? signerAddress).trim();
  if (!walletAddress) {
    throw new Error("Resolved asset cleanup requires a wallet address.");
  }
  if (walletAddress !== signerAddress) {
    throw new Error(
      `Configured wallet address (${walletAddress}) does not match signer mnemonic address (${signerAddress}).`,
    );
  }
  return { walletAddress, signer };
}

function hasRemainingQuantity(order: OpenOrder): boolean {
  const quantity = fromMicroUnits(order.quantity) ?? 0;
  const filled = fromMicroUnits(order.quantityFilled) ?? 0;
  return quantity - filled > 0;
}

function collectMarketAppIds(orders: OpenOrder[], positions: WalletPosition[], liveMarkets: AlphaMarket[]): number[] {
  const ids = new Set<number>();
  for (const order of orders) {
    if (Number.isFinite(order.marketAppId) && order.marketAppId > 0) ids.add(order.marketAppId);
  }
  for (const position of positions) {
    if (Number.isFinite(position.marketAppId) && position.marketAppId > 0) ids.add(position.marketAppId);
  }
  for (const market of liveMarkets) {
    if (Number.isFinite(market.marketAppId) && market.marketAppId > 0) ids.add(market.marketAppId);
  }
  return [...ids];
}

async function loadWalletOpenOrdersWithFallback(
  liveClient: AlphaSdkClient,
  walletAddress: string,
  marketIds: number[],
): Promise<OpenOrder[]> {
  try {
    return await liveClient.getWalletOpenOrders(walletAddress);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[alpha-cleanup] wallet order lookup via API failed; trying per-market fallback: ${message}`);
  }

  const fallbackResults = await Promise.allSettled(
    marketIds.map((marketAppId) => liveClient.getOpenOrders(marketAppId, walletAddress)),
  );
  const failures = fallbackResults.filter((result) => result.status === "rejected");
  const orders = fallbackResults.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  if (orders.length === 0 && failures.length > 0) {
    throw new Error("Unable to load wallet open orders from API and per-market fallback.");
  }
  return orders;
}

async function buildKnownMarketsFromWallet(
  liveClient: AlphaSdkClient,
  walletAddress: string,
): Promise<{ knownMarkets: KnownAlphaMarket[]; walletOrders: OpenOrder[] }> {
  const [positionsResult, liveMarketsResult] = await Promise.allSettled([
    liveClient.getPositions(walletAddress),
    liveClient.getLiveMarkets(),
  ]);
  const positions = positionsResult.status === "fulfilled" ? positionsResult.value : [];
  if (positionsResult.status === "rejected") {
    const message = positionsResult.reason instanceof Error ? positionsResult.reason.message : String(positionsResult.reason);
    console.error(`[alpha-cleanup] wallet positions lookup failed; continuing without positions: ${message}`);
  }
  const liveMarkets = liveMarketsResult.status === "fulfilled" ? liveMarketsResult.value : [];
  if (liveMarketsResult.status === "rejected") {
    const message =
      liveMarketsResult.reason instanceof Error ? liveMarketsResult.reason.message : String(liveMarketsResult.reason);
    console.error(`[alpha-cleanup] live markets lookup failed; continuing without live enrichment: ${message}`);
  }

  const seedIds = collectMarketAppIds([], positions, liveMarkets);
  const walletOrders = await loadWalletOpenOrdersWithFallback(liveClient, walletAddress, seedIds);
  const marketAppIds = collectMarketAppIds(walletOrders, positions, liveMarkets);

  const liveByAppId = new Map(liveMarkets.map((market) => [market.marketAppId, market]));
  const positionByAppId = new Map(positions.map((position) => [position.marketAppId, position]));

  const knownMarkets: KnownAlphaMarket[] = [];
  for (const marketAppId of marketAppIds) {
    const live = liveByAppId.get(marketAppId);
    const position = positionByAppId.get(marketAppId);
    const resolution = await liveClient.getMarketResolution(marketAppId);
    const isResolved = resolution.isResolved === true;
    const isClosed = isResolved || resolution.isActivated === false;
    const isLive = !isClosed && resolution.isActivated !== false;
    knownMarkets.push({
      marketAppId,
      marketId: live?.id ?? null,
      slug: live?.slug ?? (typeof position?.title === "string" ? position.title : null),
      isResolved,
      isLive,
      isClosed,
    });
  }

  return { knownMarkets, walletOrders };
}

export async function runResolvedAssetCleanup(options: CleanupOptions): Promise<void> {
  console.log(
    "[alpha-cleanup] CLI wallet ASA cleanup only — does not load/save bot state or adjust realisedPnl (claim lane owns trading PnL).",
  );
  const config = readAlphaConfig();
  const { walletAddress, signer } = resolveWalletAddressAndSigner();
  const algod = new algosdk.Algodv2(config.algodToken ?? "", config.algodServer, "");

  const liveClient = new AlphaSdkClient(config, false);
  const { knownMarkets, walletOrders } = await buildKnownMarketsFromWallet(liveClient, walletAddress);
  const resolvedMarkets = knownMarkets.filter((market) => market.isResolved);
  const creatorToMarket = new Map<string, KnownAlphaMarket>();
  for (const market of knownMarkets) {
    creatorToMarket.set(algosdk.getApplicationAddress(market.marketAppId).toString(), market);
  }

  const activeBidMarkets = new Set(
    walletOrders.filter((order) => order.side === 1 && hasRemainingQuantity(order)).map((order) => order.marketAppId),
  );

  const accountInfo = (await algod.accountInformation(walletAddress).do()) as AccountInfoResponse;
  const walletHoldings = normalizeWalletAssetHoldings(accountInfo);
  const matchedHoldings: MatchedAssetHolding[] = [];

  for (const holding of walletHoldings) {
    const creator = await resolveHoldingCreator(algod, holding);
    if (!creator) continue;
    const market = creatorToMarket.get(creator);
    if (!market) continue;
    matchedHoldings.push({
      market,
      marketCreatorAddress: creator,
      assetId: holding.assetId,
      amount: holding.amount,
    });
  }

  if (matchedHoldings.length === 0) {
    printSummary({
      dryRun: !options.execute,
      walletAddress,
      resolvedMarkets: resolvedMarkets.length,
      walletAssetHoldings: walletHoldings.length,
      matchedHoldings: 0,
      attemptedCloseOuts: 0,
      successfulCloseOuts: 0,
      skippedForActiveBids: 0,
    });
    return;
  }

  const closeOutCandidates = matchedHoldings.filter(
    (holding) => holding.market.isResolved || (holding.amount === 0n && !activeBidMarkets.has(holding.market.marketAppId)),
  );
  const skippedForActiveBids = matchedHoldings.filter(
    (holding) => holding.amount === 0n && activeBidMarkets.has(holding.market.marketAppId),
  ).length;
  const limitedHoldings =
    options.limit && options.limit > 0 ? closeOutCandidates.slice(0, options.limit) : closeOutCandidates;

  console.log(`Matched ${matchedHoldings.length} market-created ASA holdings.`);
  if (skippedForActiveBids > 0) {
    console.log(`Skipped ${skippedForActiveBids} zero-balance holdings due to active bids on those markets.`);
  }
  if (options.limit && options.limit > 0) {
    console.log(`Applying limit: processing first ${limitedHoldings.length} holdings.`);
  }
  for (const holding of limitedHoldings) {
    const amountLabel = holding.amount.toString();
    console.log(
      `- market=${formatMarketLabel(holding.market)} asset=${holding.assetId} creator=${holding.marketCreatorAddress} amount=${amountLabel}`,
    );
  }

  let successfulCloseOuts = 0;

  if (options.execute) {
    const claimClient = new AlphaSdkClient(config, true);
    for (const holding of limitedHoldings) {
      // Non-zero balances are redeemed via claim: winning tokens return USDC,
      // losing tokens burn, and the ASA opt-in is closed in the same group.
      if (holding.amount > 0n) {
        try {
          const result = await claimClient.claim({
            marketAppId: holding.market.marketAppId,
            assetId: holding.assetId,
          });
          successfulCloseOuts += 1;
          console.log(
            `  claimed asset=${holding.assetId} market_app=${holding.market.marketAppId} txids=${result.txIds.join(",")}`,
          );
          continue;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(
            `  claim failed asset=${holding.assetId} market_app=${holding.market.marketAppId}: ${message}; falling back to close-out`,
          );
        }
      }
      // Zero-balance opt-ins (or claim fallback) close the ASA back to the
      // market creator to reclaim the Algorand minimum balance.
      const suggestedParams = await algod.getTransactionParams().do();
      const closeTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: walletAddress,
        receiver: holding.marketCreatorAddress,
        amount: 0,
        assetIndex: holding.assetId,
        closeRemainderTo: holding.marketCreatorAddress,
        suggestedParams,
      });
      const signed = closeTxn.signTxn(signer.sk);
      const sendResult = await algod.sendRawTransaction(signed).do();
      await algosdk.waitForConfirmation(algod, sendResult.txid, 8);
      successfulCloseOuts += 1;
      console.log(
        `  closed asset=${holding.assetId} market_app=${holding.market.marketAppId} txid=${sendResult.txid}`,
      );
    }
  }

  printSummary({
    dryRun: !options.execute,
    walletAddress,
    resolvedMarkets: resolvedMarkets.length,
    walletAssetHoldings: walletHoldings.length,
    matchedHoldings: matchedHoldings.length,
    attemptedCloseOuts: limitedHoldings.length,
    successfulCloseOuts,
    skippedForActiveBids,
  });
}
