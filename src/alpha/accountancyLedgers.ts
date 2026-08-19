import type { AlphaBotState } from "./alphaTypes.js";

/**
 * Phase 5 accountancy: three independent truths.
 * - Trading PnL: fill/settlement realised + mark unrealised (never rewards)
 * - Rewards: on-chain LP receipts only (never invents trading PnL)
 * - Cash: wallet free USDC + bid escrow (not startingBalance / seed capital)
 *
 * Optional totalEconomic = trading + rewards received (explicit sum, not net-worth-minus-seed).
 */

export type TradingLedger = {
  realisedPnlUsd: number;
  unrealisedPnlUsd: number;
  tradingPnlUsd: number;
};

export type RewardsLedger = {
  /** Lifetime on-chain LP receipts from the reward sender scan. */
  receivedUsd: number;
  /** Accrual estimate from resting liquidity — not trading PnL. */
  estimatedAccrualUsd: number;
  asOf?: string;
};

export type CashLedger = {
  walletUsdc?: number;
  bidEscrowUsd: number;
  /** Wallet free + bid escrow. Undefined when wallet balance is unknown. */
  cashUsdc?: number;
};

export type AccountancySnapshot = {
  trading: TradingLedger;
  rewards: RewardsLedger;
  cash: CashLedger;
  positionsValueUsd: number;
  /** Cash + mark/locked inventory value (wealth), not a PnL figure. */
  netWorthUsd?: number;
  /** trading.tradingPnlUsd + rewards.receivedUsd — explicitly labeled sum. */
  totalEconomicUsd: number;
};

export function computeTradingLedger(
  state: Pick<AlphaBotState, "realisedPnl" | "unrealisedPnl" | "totalPnl">,
): TradingLedger {
  const realisedPnlUsd = state.realisedPnl;
  const unrealisedPnlUsd = state.unrealisedPnl;
  const tradingPnlUsd = Number.isFinite(state.totalPnl)
    ? state.totalPnl
    : realisedPnlUsd + unrealisedPnlUsd;
  return { realisedPnlUsd, unrealisedPnlUsd, tradingPnlUsd };
}

export function computeRewardsLedger(
  state: Pick<AlphaBotState, "estimatedRewardsUsd" | "capitalLedger">,
): RewardsLedger {
  return {
    receivedUsd: state.capitalLedger?.rewardsReceivedUsd ?? 0,
    estimatedAccrualUsd: state.estimatedRewardsUsd,
    asOf: state.capitalLedger?.lastScanAt,
  };
}

export function computeCashLedger(
  walletUsdc: number | undefined,
  bidEscrowUsd: number,
): CashLedger {
  const escrow = Number.isFinite(bidEscrowUsd) ? Math.max(0, bidEscrowUsd) : 0;
  if (walletUsdc === undefined || !Number.isFinite(walletUsdc)) {
    return { walletUsdc: undefined, bidEscrowUsd: escrow, cashUsdc: undefined };
  }
  return {
    walletUsdc,
    bidEscrowUsd: escrow,
    cashUsdc: walletUsdc + escrow,
  };
}

export function buildAccountancySnapshot(input: {
  state: AlphaBotState;
  walletUsdc?: number;
  bidEscrowUsd: number;
  positionsValueUsd: number;
}): AccountancySnapshot {
  const trading = computeTradingLedger(input.state);
  const rewards = computeRewardsLedger(input.state);
  const cash = computeCashLedger(input.walletUsdc, input.bidEscrowUsd);
  const positionsValueUsd = Number.isFinite(input.positionsValueUsd) ? input.positionsValueUsd : 0;
  const netWorthUsd = cash.cashUsdc === undefined ? undefined : cash.cashUsdc + positionsValueUsd;
  return {
    trading,
    rewards,
    cash,
    positionsValueUsd,
    netWorthUsd,
    totalEconomicUsd: trading.tradingPnlUsd + rewards.receivedUsd,
  };
}

/**
 * Persist reward/flow scan results into bot state without touching trading
 * positions, fill history, or realised/unrealised PnL.
 */
export function applyRewardFlowsToState(
  state: AlphaBotState,
  flows: {
    rewardsReceivedUsd: number;
    marketUsdcInUsd: number;
    marketUsdcOutUsd: number;
    externalInUsd: number;
    externalOutUsd: number;
  },
  scanMeta: { pagesScanned: number; transfersScanned: number },
): void {
  state.capitalLedger = {
    lastScanAt: new Date().toISOString(),
    rewardsReceivedUsd: flows.rewardsReceivedUsd,
    marketUsdcInUsd: flows.marketUsdcInUsd,
    marketUsdcOutUsd: flows.marketUsdcOutUsd,
    externalInUsd: flows.externalInUsd,
    externalOutUsd: flows.externalOutUsd,
    pagesScanned: scanMeta.pagesScanned,
    transfersScanned: scanMeta.transfersScanned,
  };
}

export function formatAccountancyDigestLines(
  snapshot: AccountancySnapshot,
  formatUsd: (value: number | undefined) => string,
  formatRewardUsd: (value: number | undefined) => string = formatUsd,
): string[] {
  return [
    `trading: realised=${formatUsd(snapshot.trading.realisedPnlUsd)} unrealised=${formatUsd(
      snapshot.trading.unrealisedPnlUsd,
    )} total=${formatUsd(snapshot.trading.tradingPnlUsd)}`,
    `rewards: received=${formatRewardUsd(snapshot.rewards.receivedUsd)} est_accrual=${formatRewardUsd(
      snapshot.rewards.estimatedAccrualUsd,
    )}`,
    `cash: wallet=${formatUsd(snapshot.cash.walletUsdc)} bid_escrow=${formatUsd(snapshot.cash.bidEscrowUsd)} total=${formatUsd(
      snapshot.cash.cashUsdc,
    )}`,
    `total_economic: trading+rewards=${formatUsd(snapshot.totalEconomicUsd)}`,
  ];
}
