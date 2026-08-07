import type { OpenOrder, WalletPosition } from "@alpha-arcade/sdk";

import { readAlphaConfig } from "./alphaConfig.js";
import { loadAlphaScan } from "./alphaMarketScanner.js";
import { AlphaSdkClient, fromMicroUnits } from "./alphaClient.js";
import { buildCapitalLedger, mergeCapitalLedgerIntoState, type CapitalLedger } from "./capitalLedger.js";
import { summarizeLiveExposure } from "./alphaFormatter.js";
import { loadAlphaState, saveAlphaState } from "./alphaStateStore.js";
import type { AlphaBotState, AlphaMarket, AlphaOrderbook, AlphaPaperOrder, AlphaPaperPosition } from "./alphaTypes.js";

export type DashboardPositionRow = {
  marketId: string;
  marketAppId?: number;
  slug?: string;
  title: string;
  outcome: "YES" | "NO";
  shares: number;
  avgCost?: number;
  lockedUsd?: number;
  mark?: number;
  unrealisedPnl?: number;
  valueUsd?: number;
};

export type DashboardOpenOrderRow = {
  id: string;
  marketAppId: number;
  slug?: string;
  title: string;
  outcome: "YES" | "NO";
  side: "bid" | "ask";
  source: "reward" | "spread" | "inventory_exit";
  price: number;
  remainingShares: number;
  notionalUsd: number;
  createdAt: string;
  rewardEligible: boolean;
};

export type DashboardActivityItem = {
  id: string;
  type: "fill" | "cancel";
  title: string;
  outcome: "YES" | "NO";
  side: "bid" | "ask";
  price: number;
  shares: number;
  updatedAt: string;
  source: "reward" | "spread" | "inventory_exit";
  reason?: string;
};

export type AlphaDashboardSnapshot = {
  asOf: string;
  botStateKey: string;
  walletAddress?: string;
  walletBalances: {
    usdc?: number;
    algo?: number;
  };
  health: {
    cacheTtlMs: number;
    stateLastUpdated: string;
    errors: string[];
  };
  overview: {
    openOrders: number;
    bidOrders: number;
    exitOrders: number;
    rewardEligibleBidOrders: number;
    bidExposureUsd: number;
    rewardBidExposureUsd: number;
    rewardEligibleBidExposureUsd: number;
    spreadBidExposureUsd: number;
    exitNotionalUsd: number;
    rewardEligibleExitNotionalUsd: number;
    controlledExitNotionalUsd: number;
    exitPnlIfFilledUsd: number;
    realisedPlusOpenExitPnlUsd: number;
    underwaterInventoryNotionalUsd: number;
    underwaterInventoryUnrealisedLossUsd: number;
    activeRewardLiquidityShare?: number;
    potentialRewardLiquidityShare?: number;
    activeRewardRateDailyUsd?: number;
    activeRewardRateHourlyUsd?: number;
    potentialRewardRateDailyUsd?: number;
    potentialRewardRateHourlyUsd?: number;
    realisedPnl: number;
    unrealisedPnl: number;
    tradingPnl: number;
    estimatedRewardsUsd: number;
    spreadPnl: number;
    parityPnl: number;
    liveOrdersPlaced: number;
    liveOrdersCancelled: number;
  };
  positions: DashboardPositionRow[];
  openOrders: DashboardOpenOrderRow[];
  activity: DashboardActivityItem[];
  realPnl?: DashboardRealPnl;
};

export type DashboardRealPnl = {
  /** @deprecated Seed/observed capital ref only — not trading truth. */
  contributedCapitalUsd: number;
  netWorthUsd?: number;
  /** @deprecated Prefer totalEconomicUsd. */
  realPnlUsd?: number;
  walletUsdc?: number;
  bidEscrowUsd: number;
  cashUsdc?: number;
  positionsValueUsd: number;
  rewardsReceivedUsd: number;
  marketUsdcInUsd: number;
  marketUsdcOutUsd: number;
  tradingPnlUsd: number;
  realisedPnlUsd: number;
  unrealisedPnlUsd: number;
  estimatedRewardsUsd: number;
  totalEconomicUsd: number;
  externalCapitalDriftUsd: number;
  ledgerCachedAt?: string;
};

function toDashboardRealPnl(ledger: CapitalLedger): DashboardRealPnl {
  return {
    contributedCapitalUsd: ledger.contributedCapitalUsd,
    netWorthUsd: ledger.netWorthUsd,
    realPnlUsd: ledger.realPnlUsd,
    walletUsdc: ledger.accountancy.cash.walletUsdc,
    bidEscrowUsd: ledger.accountancy.cash.bidEscrowUsd,
    cashUsdc: ledger.accountancy.cash.cashUsdc,
    positionsValueUsd: ledger.accountancy.positionsValueUsd,
    rewardsReceivedUsd: ledger.accountancy.rewards.receivedUsd,
    marketUsdcInUsd: ledger.flows.marketUsdcInUsd,
    marketUsdcOutUsd: ledger.flows.marketUsdcOutUsd,
    tradingPnlUsd: ledger.accountancy.trading.tradingPnlUsd,
    realisedPnlUsd: ledger.accountancy.trading.realisedPnlUsd,
    unrealisedPnlUsd: ledger.accountancy.trading.unrealisedPnlUsd,
    estimatedRewardsUsd: ledger.accountancy.rewards.estimatedAccrualUsd,
    totalEconomicUsd: ledger.accountancy.totalEconomicUsd,
    externalCapitalDriftUsd: ledger.reconciliation.externalCapitalDriftUsd,
    ledgerCachedAt: ledger.scanMeta.cachedAt,
  };
}

function toPositionRowsFromState(state: AlphaBotState): DashboardPositionRow[] {
  const rows: DashboardPositionRow[] = [];
  for (const position of Object.values(state.positionsByMarket)) {
    if (position.yesShares > 0) {
      const mark = position.lastMark;
      rows.push({
        marketId: position.marketId,
        marketAppId: position.marketAppId,
        slug: position.slug,
        title: position.title,
        outcome: "YES",
        shares: position.yesShares,
        avgCost: position.avgYesCost,
        lockedUsd: position.avgYesCost * position.yesShares,
        mark,
        unrealisedPnl: mark !== undefined ? (mark - position.avgYesCost) * position.yesShares : undefined,
        valueUsd: mark !== undefined ? mark * position.yesShares : undefined,
      });
    }
    if (position.noShares > 0) {
      const mark = position.lastMark !== undefined ? 1 - position.lastMark : undefined;
      rows.push({
        marketId: position.marketId,
        marketAppId: position.marketAppId,
        slug: position.slug,
        title: position.title,
        outcome: "NO",
        shares: position.noShares,
        avgCost: position.avgNoCost,
        lockedUsd: position.avgNoCost * position.noShares,
        mark,
        unrealisedPnl: mark !== undefined ? (mark - position.avgNoCost) * position.noShares : undefined,
        valueUsd: mark !== undefined ? mark * position.noShares : undefined,
      });
    }
  }
  return rows.sort((a, b) => (b.lockedUsd ?? b.valueUsd ?? 0) - (a.lockedUsd ?? a.valueUsd ?? 0));
}

function knownAvgCost(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function toPositionRowsFromWallet(
  positions: WalletPosition[],
  slugByMarketAppId: Map<number, string>,
  trackedByMarketAppId: Map<number, AlphaPaperPosition>,
): DashboardPositionRow[] {
  const rows: DashboardPositionRow[] = [];
  for (const position of positions) {
    const yesShares = fromMicroUnits(position.yesBalance) ?? 0;
    const noShares = fromMicroUnits(position.noBalance) ?? 0;
    const tracked = trackedByMarketAppId.get(position.marketAppId);
    if (yesShares > 0) {
      const avgCost = knownAvgCost(tracked?.avgYesCost);
      const mark = tracked?.lastMark;
      rows.push({
        marketId: String(position.marketAppId),
        marketAppId: position.marketAppId,
        slug: tracked?.slug ?? slugByMarketAppId.get(position.marketAppId),
        title: position.title,
        outcome: "YES",
        shares: yesShares,
        avgCost,
        lockedUsd: avgCost !== undefined ? avgCost * yesShares : undefined,
        mark,
        unrealisedPnl: avgCost !== undefined && mark !== undefined ? (mark - avgCost) * yesShares : undefined,
        valueUsd: mark !== undefined ? mark * yesShares : undefined,
      });
    }
    if (noShares > 0) {
      const avgCost = knownAvgCost(tracked?.avgNoCost);
      const mark = tracked?.lastMark !== undefined ? 1 - tracked.lastMark : undefined;
      rows.push({
        marketId: String(position.marketAppId),
        marketAppId: position.marketAppId,
        slug: tracked?.slug ?? slugByMarketAppId.get(position.marketAppId),
        title: position.title,
        outcome: "NO",
        shares: noShares,
        avgCost,
        lockedUsd: avgCost !== undefined ? avgCost * noShares : undefined,
        mark,
        unrealisedPnl: avgCost !== undefined && mark !== undefined ? (mark - avgCost) * noShares : undefined,
        valueUsd: mark !== undefined ? mark * noShares : undefined,
      });
    }
  }
  return rows.sort((a, b) => (b.lockedUsd ?? b.valueUsd ?? b.shares) - (a.lockedUsd ?? a.valueUsd ?? a.shares));
}

function toOpenOrderRow(order: AlphaPaperOrder): DashboardOpenOrderRow {
  return {
    id: order.id,
    marketAppId: order.marketAppId,
    slug: order.slug,
    title: order.title,
    outcome: order.outcome,
    side: order.side,
    source: order.source,
    price: order.price,
    remainingShares: order.remainingShares,
    notionalUsd: order.side === "bid" ? order.price * order.remainingShares : order.notionalUsd,
    createdAt: order.createdAt,
    rewardEligible: order.rewardEligible,
  };
}

function toOpenOrderRowsFromWallet(
  orders: OpenOrder[],
  slugByMarketAppId: Map<number, string>,
  trackedByEscrowAppId: Map<string, AlphaPaperOrder>,
): DashboardOpenOrderRow[] {
  return orders
    .map((order) => {
      const tracked = trackedByEscrowAppId.get(String(order.escrowAppId));
      const side = order.side === 1 ? "bid" : "ask";
      const price = fromMicroUnits(order.price) ?? 0;
      const quantity = fromMicroUnits(order.quantity) ?? 0;
      const filledShares = fromMicroUnits(order.quantityFilled) ?? 0;
      const remainingShares = Math.max(0, quantity - filledShares);
      return {
        id: `live:${order.escrowAppId}`,
        marketAppId: order.marketAppId,
        slug: tracked?.slug ?? slugByMarketAppId.get(order.marketAppId),
        title: tracked?.title ?? `market ${order.marketAppId}`,
        outcome: tracked?.outcome ?? (order.position === 1 ? "YES" : "NO"),
        side: tracked?.side ?? side,
        source: tracked?.source ?? "spread",
        price,
        remainingShares,
        notionalUsd: side === "bid" ? price * remainingShares : 0,
        createdAt: tracked?.createdAt ?? new Date().toISOString(),
        rewardEligible: tracked?.rewardEligible ?? false,
      } satisfies DashboardOpenOrderRow;
    })
    .filter((order) => order.remainingShares > 0);
}

function buildActivity(state: AlphaBotState): DashboardActivityItem[] {
  const fills = state.fills.slice(-30).map((fill) => ({
    id: `fill:${fill.id}:${fill.updatedAt}`,
    type: "fill" as const,
    title: fill.title,
    outcome: fill.outcome,
    side: fill.side,
    price: fill.price,
    shares: fill.filledShares || fill.sizeShares,
    updatedAt: fill.updatedAt,
    source: fill.source,
    reason: fill.reason,
  }));
  const cancelled = state.cancelledOrders.slice(-30).map((order) => ({
    id: `cancel:${order.id}:${order.updatedAt}`,
    type: "cancel" as const,
    title: order.title,
    outcome: order.outcome,
    side: order.side,
    price: order.price,
    shares: order.remainingShares || order.sizeShares,
    updatedAt: order.updatedAt,
    source: order.source,
    reason: order.reason,
  }));
  return [...fills, ...cancelled]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 40);
}

type SnapshotCache = {
  fetchedAtMs: number;
  snapshot: AlphaDashboardSnapshot;
};

const cacheByWallet = new Map<string, SnapshotCache>();

function readCacheTtlMs(): number {
  const parsed = Number.parseInt(process.env.ALPHA_DASHBOARD_CACHE_MS ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 5_000;
  return parsed;
}

function cacheKey(walletAddress: string | undefined): string {
  return walletAddress?.trim().toUpperCase() || "__DEFAULT__";
}

export async function buildAlphaDashboardSnapshot(walletAddressOverride?: string): Promise<AlphaDashboardSnapshot> {
  const config = readAlphaConfig();
  const walletAddress = walletAddressOverride?.trim() || config.walletAddress;
  const ttlMs = readCacheTtlMs();
  const key = cacheKey(walletAddress);
  const cached = cacheByWallet.get(key);
  if (cached && Date.now() - cached.fetchedAtMs < ttlMs) return cached.snapshot;

  const state = await loadAlphaState(config.stateKey, config.paperStartingBalanceUsd);
  const errors: string[] = [];
  const sdkClient = new AlphaSdkClient(config, false);

  let walletUsdc: number | undefined;
  let walletAlgo: number | undefined;
  let walletPositions: WalletPosition[] | undefined;
  let walletOrders: OpenOrder[] | undefined;
  let slugByMarketAppId = new Map<number, string>();
  let marketsByAppId = new Map<number, AlphaMarket>();
  const rewardOrderbooks = new Map<number, AlphaOrderbook>();

  try {
    const scan = await loadAlphaScan(config);
    const markets = [...new Map([...scan.rewardMarkets, ...scan.markets].map((market) => [market.marketAppId, market])).values()];
    marketsByAppId = new Map(markets.map((market) => [market.marketAppId, market]));
    slugByMarketAppId = new Map(
      markets
        .filter((market) => typeof market.slug === "string" && market.slug.length > 0)
        .map((market) => [market.marketAppId, market.slug as string]),
    );
    for (const [marketAppId, book] of scan.orderbooks) {
      rewardOrderbooks.set(marketAppId, book);
    }
  } catch (error) {
    errors.push(`Amarok market metadata unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const rewardMarketAppIds = new Set(
    state.openOrders
      .filter((order) => order.status === "open" && order.runMode === "live" && order.rewardEligible)
      .map((order) => order.marketAppId),
  );
  for (const marketAppId of rewardMarketAppIds) {
    if (rewardOrderbooks.has(marketAppId)) continue;
    const market = marketsByAppId.get(marketAppId);
    if (!market) continue;
    errors.push(`Reward orderbook unavailable for ${marketAppId} in Amarok scan`);
  }

  const exposure = summarizeLiveExposure(state, config, {
    markets: marketsByAppId,
    orderbooks: rewardOrderbooks,
    walletAddress,
  });

  if (walletAddress) {
    try {
      walletUsdc = await sdkClient.getUsdcBalance(walletAddress);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      walletAlgo = await sdkClient.getAlgoBalance(walletAddress);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      walletPositions = await sdkClient.getPositions(walletAddress);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      walletOrders = await sdkClient.getWalletOpenOrders(walletAddress);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  } else {
    errors.push("No wallet configured. Set ALPHA_WALLET_ADDRESS or pass ?wallet=<address>.");
  }

  const positionRows = walletPositions
    ? toPositionRowsFromWallet(
        walletPositions,
        slugByMarketAppId,
        new Map(
          Object.values(state.positionsByMarket)
            .filter((position) => position.marketAppId !== undefined)
            .map((position) => [position.marketAppId as number, position]),
        ),
      )
    : toPositionRowsFromState(state);

  const openOrderRows = walletOrders
    ? toOpenOrderRowsFromWallet(
        walletOrders,
        slugByMarketAppId,
        new Map(
          state.openOrders
            .filter((order) => order.status === "open" && order.liveEscrowAppId !== undefined)
            .map((order) => [String(order.liveEscrowAppId), order]),
        ),
      )
    : state.openOrders.filter((o) => o.status === "open").map(toOpenOrderRow);

  const escrowAppIds = [
    ...state.openOrders
      .filter((order) => order.status === "open" && order.liveEscrowAppId !== undefined)
      .map((order) => order.liveEscrowAppId as number),
    ...(walletOrders ?? []).map((order) => order.escrowAppId),
  ];

  let realPnl: DashboardRealPnl | undefined;
  try {
    const ledger = await buildCapitalLedger({
      config,
      walletAddress,
      walletUsdc,
      bidEscrowUsd: exposure.bidExposureUsd,
      positions: positionRows,
      state,
      marketAppIds: [...marketsByAppId.keys()],
      escrowAppIds,
    });
    realPnl = toDashboardRealPnl(ledger);
    if (ledger.flowsRefreshed) {
      await saveAlphaState(config.stateKey, mergeCapitalLedgerIntoState(state, ledger.flows, ledger.scanMeta));
    }
  } catch (error) {
    errors.push(`Accountancy ledger unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const snapshot: AlphaDashboardSnapshot = {
    asOf: new Date().toISOString(),
    botStateKey: config.stateKey,
    walletAddress,
    walletBalances: {
      usdc: walletUsdc,
      algo: walletAlgo,
    },
    health: {
      cacheTtlMs: ttlMs,
      stateLastUpdated: state.lastUpdated,
      errors,
    },
    overview: {
      openOrders: exposure.openOrders,
      bidOrders: exposure.bidOrders,
      exitOrders: exposure.exitOrders,
      rewardEligibleBidOrders: exposure.rewardEligibleBidOrders,
      bidExposureUsd: exposure.bidExposureUsd,
      rewardBidExposureUsd: exposure.rewardBidExposureUsd,
      rewardEligibleBidExposureUsd: exposure.rewardEligibleBidExposureUsd,
      spreadBidExposureUsd: exposure.spreadBidExposureUsd,
      exitNotionalUsd: exposure.exitNotionalUsd,
      rewardEligibleExitNotionalUsd: exposure.rewardEligibleExitNotionalUsd,
      controlledExitNotionalUsd: exposure.controlledExitNotionalUsd,
      exitPnlIfFilledUsd: exposure.exitPnlIfFilledUsd,
      realisedPlusOpenExitPnlUsd: exposure.realisedPlusOpenExitPnlUsd,
      underwaterInventoryNotionalUsd: exposure.underwaterInventoryNotionalUsd,
      underwaterInventoryUnrealisedLossUsd: exposure.underwaterInventoryUnrealisedLossUsd,
      activeRewardLiquidityShare: exposure.activeRewardLiquidityShare,
      potentialRewardLiquidityShare: exposure.potentialRewardLiquidityShare,
      activeRewardRateDailyUsd: exposure.activeRewardRateDailyUsd,
      activeRewardRateHourlyUsd: exposure.activeRewardRateHourlyUsd,
      potentialRewardRateDailyUsd: exposure.potentialRewardRateDailyUsd,
      potentialRewardRateHourlyUsd: exposure.potentialRewardRateHourlyUsd,
      realisedPnl: state.realisedPnl,
      unrealisedPnl: state.unrealisedPnl,
      tradingPnl: state.totalPnl,
      estimatedRewardsUsd: state.estimatedRewardsUsd,
      spreadPnl: state.strategyStats.spreadRealisedPnl,
      parityPnl: state.strategyStats.parityGrossPnl,
      liveOrdersPlaced: state.strategyStats.liveOrdersPlaced,
      liveOrdersCancelled: state.strategyStats.liveOrdersCancelled,
    },
    positions: positionRows,
    openOrders: openOrderRows,
    activity: buildActivity(state),
    realPnl,
  };

  cacheByWallet.set(key, {
    fetchedAtMs: Date.now(),
    snapshot,
  });

  try {
    const { publishGhilliePublicPnl } = await import("./publicPnl.js");
    await publishGhilliePublicPnl(snapshot);
  } catch (error) {
    snapshot.health.errors.push(
      `Public PnL publish skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return snapshot;
}
