/**
 * `dailyRewardsSource` value used when the API exposes no genuine daily-emission
 * field and the client falls back to treating the entire reward pool as a
 * "daily" figure. Markets tagged this way historically pay ~$0, so reward
 * income reporting and the reward lane both treat this as unreliable.
 */
export const POOL_FALLBACK_DAILY_REWARD_SOURCE = "totalRewards-pool-fallback";

export type AlphaOutcome = "YES" | "NO";
export type AlphaOrderSide = "bid" | "ask";
export type AlphaOrderStatus = "open" | "filled" | "cancelled" | "expired";
export type AlphaOrderbookSource = "api" | "onchain_orderbook" | "unavailable";

export type AlphaRewardInfo = {
  isRewardMarket: boolean;
  totalRewardsUsd?: number;
  rewardsPaidOutUsd?: number;
  remainingRewardsUsd?: number;
  dailyRewardsUsd?: number;
  dailyRewardsSource?: string;
  lastPayoutUsd?: number;
  maxRewardSpreadCents?: number;
  minContracts?: number;
  competitionLevel?: "low" | "medium" | "high" | "unknown";
};

export type AlphaMarket = {
  id: string;
  marketAppId: number;
  slug?: string;
  title: string;
  category?: string;
  status: string;
  closeTime?: string;
  endTs?: number;
  resolved: boolean;
  yesPrice?: number;
  noPrice?: number;
  volume?: number;
  liquidity?: number;
  reward: AlphaRewardInfo;
  raw: unknown;
  /** Amarok `get_quotes` suggestions for this market, when the scan included them. */
  suggestedQuotes?: AlphaQuote[];
};

export type AlphaBookLevel = {
  price: number;
  quantityShares: number;
  escrowAppId?: number;
  owner?: string;
};

export type AlphaOrderbook = {
  marketId: string;
  marketAppId: number;
  slug?: string;
  source: AlphaOrderbookSource;
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  yesMid?: number;
  noMid?: number;
  yesSpread?: number;
  noSpread?: number;
  bestSpread?: number;
  yesSideOrders: {
    bids: AlphaBookLevel[];
    asks: AlphaBookLevel[];
  };
  noSideOrders: {
    bids: AlphaBookLevel[];
    asks: AlphaBookLevel[];
  };
  raw?: unknown;
};

export type AlphaQuote = {
  id: string;
  marketId: string;
  marketAppId: number;
  slug?: string;
  title: string;
  outcome: AlphaOutcome;
  side: AlphaOrderSide;
  price: number;
  sizeShares: number;
  notionalUsd: number;
  reason: string;
  rewardEligible: boolean;
  rewardZoneDistanceCents?: number;
  rewardMinContracts?: number;
  estimatedRewardUsdPerDay?: number;
  source: "reward" | "spread" | "inventory_exit";
};

export type AlphaPaperOrder = AlphaQuote & {
  runMode?: "paper" | "live";
  createdAt: string;
  updatedAt: string;
  status: AlphaOrderStatus;
  reservedUsd: number;
  filledShares: number;
  remainingShares: number;
  liveEscrowAppId?: number;
  liveTxIds?: string[];
  owner?: string;
};

export type AlphaPaperPosition = {
  marketId: string;
  marketAppId?: number;
  slug?: string;
  title: string;
  yesShares: number;
  noShares: number;
  avgYesCost: number;
  avgNoCost: number;
  realisedPnl: number;
  unrealisedPnl: number;
  lastMark?: number;
  /**
   * Consecutive live ticks this position has been "unaccounted" (held in bot
   * state but absent from both the wallet free balance and any open sell-order
   * escrow). Used to prune stale/already-redeemed positions only after the
   * signal persists, guarding against transient wallet/API read gaps.
   */
  unaccountedTicks?: number;
};

export type AlphaSpreadMarketStats = {
  marketId: string;
  marketAppId: number;
  title: string;
  volume?: number;
  observedScans: number;
  consecutiveTwoSidedScans: number;
  bestDepthUsd?: number;
  bestSpreadCents?: number;
  lastTwoSidedAt?: string;
  lastSeenAt: string;
};

export type AlphaParityPlan = {
  type: "PARITY" | "SPLIT_MERGE";
  marketId: string;
  marketAppId: number;
  slug?: string;
  title: string;
  sizeShares: number;
  notionalUsd: number;
  yesPrice: number;
  noPrice: number;
  grossEdgeBps: number;
  estimatedNetEdgeBps: number;
  expectedGrossPnlUsd: number;
  requiredAction: string;
  warnings: string[];
};

export type AlphaParityAttempt = AlphaParityPlan & {
  id: string;
  mode: "live-dry-run" | "live" | "paper";
  status: "planned" | "executed" | "failed" | "skipped";
  reason?: string;
  txIds?: string[];
  createdAt: string;
};

export type LiveFillPriceSource = "limit" | "matched";

/** Append-only live fill ledger entry (Phase 1 execution accountancy). */
export type LiveFillEvent = {
  id: string;
  escrowAppId: number;
  marketAppId: number;
  marketId: string;
  outcome: AlphaOutcome;
  side: AlphaOrderSide;
  shares: number;
  price: number;
  priceSource: LiveFillPriceSource;
  source: AlphaQuote["source"];
  filledSharesAfter: number;
  observedAt: string;
  title?: string;
  slug?: string;
};

export type AlphaBotState = {
  startingBalance: number;
  cash: number;
  openOrders: AlphaPaperOrder[];
  positionsByMarket: Record<string, AlphaPaperPosition>;
  realisedPnl: number;
  unrealisedPnl: number;
  estimatedRewardsUsd: number;
  estimatedRewardsByMarket: Record<string, number>;
  spreadStatsByMarket: Record<string, AlphaSpreadMarketStats>;
  parityAttempts: AlphaParityAttempt[];
  rewardEligibleSeconds: number;
  totalPnl: number;
  fills: AlphaPaperOrder[];
  cancelledOrders: AlphaPaperOrder[];
  /** Append-only live fill events; source of truth for live VWAP updates. */
  liveFillEvents?: LiveFillEvent[];
  /** Last applied cumulative filled shares per escrow app id (string key). */
  liveFillCursorByEscrow?: Record<string, number>;
  strategyStats: {
    ticks: number;
    rewardMarketsSeen: number;
    candidatesSeen: number;
    quotesPlaced: number;
    liveOrdersPlaced: number;
    liveOrdersCancelled: number;
    spreadEntryFills: number;
    spreadExitFills: number;
    spreadRealisedPnl: number;
    parityTradesExecuted: number;
    parityGrossPnl: number;
    parityNetPnlEstimate: number;
    parityFailedLegs: number;
    lastParityTradeAt?: string;
    lastRunMode?: string;
  };
  notificationState?: {
    lastDailySummaryDate?: string;
  };
  capitalLedger?: {
    lastScanAt: string;
    rewardsReceivedUsd: number;
    marketUsdcInUsd: number;
    marketUsdcOutUsd: number;
    externalInUsd: number;
    externalOutUsd: number;
    pagesScanned?: number;
    transfersScanned?: number;
  };
  lastUpdated: string;
};

export type AlphaOpportunity = {
  type: "LP_REWARD" | "MAKER" | "PARITY" | "SPLIT_MERGE";
  marketId: string;
  marketAppId: number;
  slug?: string;
  title: string;
  edgeBps?: number;
  confidence: "low" | "medium" | "high";
  classification: "OBSERVATION" | "CANDIDATE" | "MECHANICAL" | "DANGER";
  reason: string;
  requiredAction: string;
  warnings: string[];
  reward: {
    rewardEligible: boolean;
    estimatedRewardUsdPerHour?: number;
    estimatedRewardUsdPerDay?: number;
    rewardZoneDistanceCents?: number;
    competitionLevel?: AlphaRewardInfo["competitionLevel"];
    rewardReason?: string;
  };
};
