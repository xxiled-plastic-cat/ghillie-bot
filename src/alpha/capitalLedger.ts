import algosdk from "algosdk";

import {
  type AccountancySnapshot,
  applyRewardFlowsToState,
  buildAccountancySnapshot,
} from "./accountancyLedgers.js";
import type { AlphaConfig } from "./alphaConfig.js";
import type { AlphaBotState } from "./alphaTypes.js";
import {
  microUsdcToUsd,
  scanWalletUsdcTransfers,
  type WalletUsdcTransfer,
} from "./indexerTransfers.js";

/** Optional seed reference for external-drift diagnostics only — not trading PnL. */
export const ALPHA_INITIAL_CAPITAL_USD = 206;
export const ALPHA_REWARD_HISTORY_SENDER =
  "LPCTQJDOFBG5J63LOUY6A6JMHHHXIVOIZ7FLN6FETFSSWQOJR56V65INTU";
const CAPITAL_LEDGER_CACHE_MS = 3_600_000;

export type TransferBucket = "reward" | "market" | "external";

export type TransferClassificationContext = {
  walletAddress: string;
  rewardSenderAddress: string;
  matcherAppAddress: string;
  marketAppAddresses: Set<string>;
  escrowAppAddresses: Set<string>;
};

export type FlowTotals = {
  rewardsReceivedUsd: number;
  marketUsdcInUsd: number;
  marketUsdcOutUsd: number;
  externalInUsd: number;
  externalOutUsd: number;
};

export type CapitalLedger = {
  asOf: string;
  /** @deprecated Seed reference for drift only; prefer accountancy.cash / observed external flows. */
  contributedCapitalUsd: number;
  netWorthUsd?: number;
  /** @deprecated Blended net-worth-minus-seed; prefer accountancy.totalEconomicUsd. */
  realPnlUsd?: number;
  accountancy: AccountancySnapshot;
  components: {
    walletUsdc?: number;
    bidEscrowUsd: number;
    positionsValueUsd: number;
  };
  flows: FlowTotals;
  reconciliation: {
    tradingPnlUsd: number;
    rewardsReceivedUsd: number;
    estimatedRewardsUsd: number;
    impliedNonTradingUsd?: number;
    externalCapitalDriftUsd: number;
  };
  scanMeta: {
    pagesScanned: number;
    transfersScanned: number;
    cachedAt?: string;
  };
  flowsRefreshed: boolean;
};

type PositionValueInput = {
  valueUsd?: number;
  lockedUsd?: number;
};

type CachedFlowEntry = {
  fetchedAtMs: number;
  flows: FlowTotals;
  scanMeta: { pagesScanned: number; transfersScanned: number };
};

const flowCacheByWallet = new Map<string, CachedFlowEntry>();

export function buildTransferClassificationContext(input: {
  walletAddress: string;
  matcherAppId: number;
  marketAppIds: number[];
  escrowAppIds: number[];
}): TransferClassificationContext {
  const marketAppAddresses = new Set(
    input.marketAppIds.map((appId) => algosdk.getApplicationAddress(appId).toString()),
  );
  const escrowAppAddresses = new Set(
    input.escrowAppIds.map((appId) => algosdk.getApplicationAddress(appId).toString()),
  );
  return {
    walletAddress: input.walletAddress,
    rewardSenderAddress: ALPHA_REWARD_HISTORY_SENDER,
    matcherAppAddress: algosdk.getApplicationAddress(input.matcherAppId).toString(),
    marketAppAddresses,
    escrowAppAddresses,
  };
}

function isMarketAddress(address: string, context: TransferClassificationContext): boolean {
  if (address === context.matcherAppAddress) return true;
  if (context.marketAppAddresses.has(address)) return true;
  if (context.escrowAppAddresses.has(address)) return true;
  return false;
}

export function classifyTransfer(
  transfer: WalletUsdcTransfer,
  context: TransferClassificationContext,
): TransferBucket {
  if (transfer.direction === "in") {
    if (transfer.sender === context.rewardSenderAddress) return "reward";
    if (isMarketAddress(transfer.sender, context)) return "market";
    return "external";
  }
  if (isMarketAddress(transfer.receiver, context)) return "market";
  return "external";
}

export function aggregateFlowTotals(
  transfers: WalletUsdcTransfer[],
  context: TransferClassificationContext,
): FlowTotals {
  const totals: FlowTotals = {
    rewardsReceivedUsd: 0,
    marketUsdcInUsd: 0,
    marketUsdcOutUsd: 0,
    externalInUsd: 0,
    externalOutUsd: 0,
  };

  for (const transfer of transfers) {
    const amountUsd = microUsdcToUsd(transfer.amountMicroUsdc);
    const bucket = classifyTransfer(transfer, context);
    if (bucket === "reward") {
      totals.rewardsReceivedUsd += amountUsd;
    } else if (bucket === "market") {
      if (transfer.direction === "in") totals.marketUsdcInUsd += amountUsd;
      else totals.marketUsdcOutUsd += amountUsd;
    } else if (transfer.direction === "in") {
      totals.externalInUsd += amountUsd;
    } else {
      totals.externalOutUsd += amountUsd;
    }
  }

  return totals;
}

export function totalPositionsValueUsd(positions: PositionValueInput[]): number {
  return positions.reduce((sum, position) => {
    if (position.valueUsd !== undefined && Number.isFinite(position.valueUsd))
      return sum + position.valueUsd;
    if (position.lockedUsd !== undefined && Number.isFinite(position.lockedUsd))
      return sum + position.lockedUsd;
    return sum;
  }, 0);
}

export function computeNetWorth(
  walletUsdc: number | undefined,
  bidEscrowUsd: number,
  positions: PositionValueInput[],
): number | undefined {
  if (walletUsdc === undefined || !Number.isFinite(walletUsdc)) return undefined;
  return walletUsdc + bidEscrowUsd + totalPositionsValueUsd(positions);
}

function flowTotalsFromState(state: AlphaBotState | undefined): FlowTotals | undefined {
  const ledger = state?.capitalLedger;
  if (!ledger) return undefined;
  return {
    rewardsReceivedUsd: ledger.rewardsReceivedUsd,
    marketUsdcInUsd: ledger.marketUsdcInUsd,
    marketUsdcOutUsd: ledger.marketUsdcOutUsd,
    externalInUsd: ledger.externalInUsd,
    externalOutUsd: ledger.externalOutUsd,
  };
}

function scanMetaFromState(state: AlphaBotState | undefined): {
  pagesScanned: number;
  transfersScanned: number;
  cachedAt?: string;
} {
  const ledger = state?.capitalLedger;
  return {
    pagesScanned: ledger?.pagesScanned ?? 0,
    transfersScanned: ledger?.transfersScanned ?? 0,
    cachedAt: ledger?.lastScanAt,
  };
}

async function refreshFlowTotals(
  walletAddress: string,
  config: AlphaConfig,
  classificationContext: TransferClassificationContext,
): Promise<{ flows: FlowTotals; scanMeta: { pagesScanned: number; transfersScanned: number } }> {
  const scan = await scanWalletUsdcTransfers(walletAddress, config);
  const flows = aggregateFlowTotals(scan.transfers, classificationContext);
  const scanMeta = {
    pagesScanned: scan.pagesScanned,
    transfersScanned: scan.transfers.length,
  };
  flowCacheByWallet.set(walletAddress, {
    fetchedAtMs: Date.now(),
    flows,
    scanMeta,
  });
  return { flows, scanMeta };
}

export function capitalLedgerSnapshotFromState(
  state: AlphaBotState,
): AlphaBotState["capitalLedger"] | undefined {
  const cached = state.capitalLedger;
  if (!cached) return undefined;
  return { ...cached };
}

/**
 * Merge indexer flow totals into state. Mutates only `capitalLedger` —
 * never trading positions, fill history, or realised/unrealised PnL.
 */
export function mergeCapitalLedgerIntoState(
  state: AlphaBotState,
  flows: FlowTotals,
  scanMeta: { pagesScanned: number; transfersScanned: number },
): AlphaBotState {
  applyRewardFlowsToState(state, flows, scanMeta);
  return state;
}

export async function buildCapitalLedger(input: {
  config: AlphaConfig;
  walletAddress?: string;
  walletUsdc?: number;
  bidEscrowUsd: number;
  positions: PositionValueInput[];
  state: AlphaBotState;
  marketAppIds: number[];
  escrowAppIds: number[];
  forceRefresh?: boolean;
}): Promise<CapitalLedger> {
  const positionsValueUsd = totalPositionsValueUsd(input.positions);
  const netWorthUsd = computeNetWorth(input.walletUsdc, input.bidEscrowUsd, input.positions);

  let flows: FlowTotals = flowTotalsFromState(input.state) ?? {
    rewardsReceivedUsd: 0,
    marketUsdcInUsd: 0,
    marketUsdcOutUsd: 0,
    externalInUsd: 0,
    externalOutUsd: 0,
  };
  let scanMeta = scanMetaFromState(input.state);
  let flowsRefreshed = false;

  if (input.walletAddress && algosdk.isValidAddress(input.walletAddress)) {
    const cacheKey = input.walletAddress;
    const cached = flowCacheByWallet.get(cacheKey);
    const cacheStale =
      input.forceRefresh || !cached || Date.now() - cached.fetchedAtMs >= CAPITAL_LEDGER_CACHE_MS;

    if (cacheStale) {
      try {
        const classificationContext = buildTransferClassificationContext({
          walletAddress: input.walletAddress,
          matcherAppId: input.config.matcherAppId,
          marketAppIds: input.marketAppIds,
          escrowAppIds: input.escrowAppIds,
        });
        const refreshed = await refreshFlowTotals(
          input.walletAddress,
          input.config,
          classificationContext,
        );
        flows = refreshed.flows;
        scanMeta = { ...refreshed.scanMeta, cachedAt: new Date().toISOString() };
        flowsRefreshed = true;
      } catch {
        if (cached) {
          flows = cached.flows;
          scanMeta = { ...cached.scanMeta, cachedAt: scanMeta.cachedAt };
        }
      }
    } else {
      flows = cached.flows;
      scanMeta = { ...cached.scanMeta, cachedAt: new Date(cached.fetchedAtMs).toISOString() };
    }
  }

  // Prefer observed external net inflows as contributed capital; fall back to
  // the historical seed only for drift diagnostics — never as trading truth.
  const observedExternalNet = flows.externalInUsd - flows.externalOutUsd;
  const contributedCapitalUsd =
    observedExternalNet > 0 ? observedExternalNet : ALPHA_INITIAL_CAPITAL_USD;
  const realPnlUsd = netWorthUsd === undefined ? undefined : netWorthUsd - contributedCapitalUsd;
  const externalCapitalDriftUsd = observedExternalNet - ALPHA_INITIAL_CAPITAL_USD;
  const impliedNonTradingUsd =
    realPnlUsd === undefined ? undefined : realPnlUsd - input.state.totalPnl;

  // Ensure accountancy rewards.received matches the flows we just resolved
  // (state may lag until mergeCapitalLedgerIntoState runs).
  const stateForAccountancy: AlphaBotState = {
    ...input.state,
    capitalLedger: {
      lastScanAt:
        scanMeta.cachedAt ?? input.state.capitalLedger?.lastScanAt ?? new Date().toISOString(),
      rewardsReceivedUsd: flows.rewardsReceivedUsd,
      marketUsdcInUsd: flows.marketUsdcInUsd,
      marketUsdcOutUsd: flows.marketUsdcOutUsd,
      externalInUsd: flows.externalInUsd,
      externalOutUsd: flows.externalOutUsd,
      pagesScanned: scanMeta.pagesScanned,
      transfersScanned: scanMeta.transfersScanned,
    },
  };
  const accountancy = buildAccountancySnapshot({
    state: stateForAccountancy,
    walletUsdc: input.walletUsdc,
    bidEscrowUsd: input.bidEscrowUsd,
    positionsValueUsd,
  });

  return {
    asOf: new Date().toISOString(),
    contributedCapitalUsd,
    netWorthUsd: accountancy.netWorthUsd ?? netWorthUsd,
    realPnlUsd,
    accountancy,
    components: {
      walletUsdc: input.walletUsdc,
      bidEscrowUsd: input.bidEscrowUsd,
      positionsValueUsd,
    },
    flows,
    reconciliation: {
      tradingPnlUsd: accountancy.trading.tradingPnlUsd,
      rewardsReceivedUsd: accountancy.rewards.receivedUsd,
      estimatedRewardsUsd: accountancy.rewards.estimatedAccrualUsd,
      impliedNonTradingUsd,
      externalCapitalDriftUsd,
    },
    scanMeta: {
      pagesScanned: scanMeta.pagesScanned,
      transfersScanned: scanMeta.transfersScanned,
      cachedAt: scanMeta.cachedAt,
    },
    flowsRefreshed,
  };
}

export function printCapitalLedgerReport(ledger: CapitalLedger, walletAddress?: string): void {
  console.log("GHILLIE ALPHA CAPITAL REPORT");
  console.log("");
  if (walletAddress) console.log(`Wallet: ${walletAddress}`);
  console.log(`As of: ${ledger.asOf}`);
  console.log("");
  console.log("Accountancy (independent ledgers)");
  console.log(
    `  Trading: realised ${fmtSignedUsd(ledger.accountancy.trading.realisedPnlUsd)} | unrealised ${fmtSignedUsd(
      ledger.accountancy.trading.unrealisedPnlUsd,
    )} | total ${fmtSignedUsd(ledger.accountancy.trading.tradingPnlUsd)}`,
  );
  console.log(
    `  Rewards (on-chain receipts): $${ledger.accountancy.rewards.receivedUsd.toFixed(6)} | est accrual $${ledger.accountancy.rewards.estimatedAccrualUsd.toFixed(6)}`,
  );
  console.log(
    `  Cash: wallet ${ledger.accountancy.cash.walletUsdc === undefined ? "unknown" : `$${ledger.accountancy.cash.walletUsdc.toFixed(2)}`} | bid escrow $${ledger.accountancy.cash.bidEscrowUsd.toFixed(
      2,
    )} | total ${ledger.accountancy.cash.cashUsdc === undefined ? "unknown" : `$${ledger.accountancy.cash.cashUsdc.toFixed(2)}`}`,
  );
  console.log(
    `  Total economic (trading + rewards): ${fmtSignedUsd(ledger.accountancy.totalEconomicUsd)}`,
  );
  console.log("");
  console.log("Wealth snapshot");
  console.log(`  Positions value: $${ledger.components.positionsValueUsd.toFixed(2)}`);
  console.log(
    `  Net worth (cash + positions): ${ledger.netWorthUsd === undefined ? "unknown" : `$${ledger.netWorthUsd.toFixed(2)}`}`,
  );
  console.log(
    `  Observed/seed capital ref: $${ledger.contributedCapitalUsd.toFixed(2)} (not trading PnL)`,
  );
  console.log("");
  console.log("Lifetime USDC flows (indexer)");
  console.log(`  Rewards received: $${ledger.flows.rewardsReceivedUsd.toFixed(6)}`);
  console.log(`  Market USDC in: $${ledger.flows.marketUsdcInUsd.toFixed(2)}`);
  console.log(`  Market USDC out: $${ledger.flows.marketUsdcOutUsd.toFixed(2)}`);
  console.log(`  External in: $${ledger.flows.externalInUsd.toFixed(2)}`);
  console.log(`  External out: $${ledger.flows.externalOutUsd.toFixed(2)}`);
  console.log("");
  console.log("Diagnostics");
  console.log(
    `  Implied non-trading vs wealth-minus-capital: ${ledger.reconciliation.impliedNonTradingUsd === undefined ? "unknown" : fmtSignedUsd(ledger.reconciliation.impliedNonTradingUsd)}`,
  );
  console.log(
    `  External capital drift vs seed $${ALPHA_INITIAL_CAPITAL_USD}: ${fmtSignedUsd(ledger.reconciliation.externalCapitalDriftUsd)}`,
  );
  console.log("");
  console.log("Scan");
  console.log(`  Pages scanned: ${ledger.scanMeta.pagesScanned}`);
  console.log(`  Transfers scanned: ${ledger.scanMeta.transfersScanned}`);
  if (ledger.scanMeta.cachedAt) console.log(`  Flow cache as of: ${ledger.scanMeta.cachedAt}`);
}

function fmtSignedUsd(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}$${value.toFixed(2)}`;
}
