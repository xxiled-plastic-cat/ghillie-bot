import type { AlphaSdkClient } from "./alphaClient.js";
import type { AlphaConfig, AlphaMode } from "./alphaConfig.js";
import type { AlphaScanResult } from "./alphaMarketScanner.js";
import { scanParity } from "./alphaParityScanner.js";
import type {
  AlphaBotState,
  AlphaMarket,
  AlphaOrderbook,
  AlphaParityAttempt,
  AlphaParityPlan,
} from "./alphaTypes.js";

type ParityAction = {
  kind: "parity" | "skip";
  message: string;
};

type ParityMode = Extract<AlphaMode, "live-dry-run" | "live">;

export type ParityResidual = {
  kind: "buy_merge_one_side" | "buy_merge_unmerged" | "split_sell_unmatched";
  marketAppId: number;
  title: string;
  shares: number;
  /** Side still stranded after a partial buy-merge (when applicable). */
  outcome?: "YES" | "NO";
  message: string;
};

export type ParityExecuteResult = {
  ok: boolean;
  txIds: string[];
  residual?: ParityResidual;
  error?: string;
};

function attempt(
  plan: AlphaParityPlan,
  mode: ParityMode,
  status: AlphaParityAttempt["status"],
  reason?: string,
  txIds: string[] = [],
): AlphaParityAttempt {
  return {
    ...plan,
    id: `parity:${plan.marketAppId}:${plan.type}:${Date.now()}`,
    mode,
    status,
    reason,
    txIds,
    createdAt: new Date().toISOString(),
  };
}

function dailyParityUsd(state: AlphaBotState): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return state.parityAttempts
    .filter((entry) => entry.status === "executed" && Date.parse(entry.createdAt) >= cutoff)
    .reduce((sum, entry) => sum + entry.notionalUsd, 0);
}

function recordSkipped(
  state: AlphaBotState,
  plan: AlphaParityPlan,
  mode: ParityMode,
  reason: string,
): void {
  state.parityAttempts.push(attempt(plan, mode, "skipped", reason));
}

function recordExecuted(
  state: AlphaBotState,
  plan: AlphaParityPlan,
  mode: ParityMode,
  txIds: string[],
): void {
  state.parityAttempts.push(attempt(plan, mode, "executed", undefined, txIds));
  state.strategyStats.parityTradesExecuted += 1;
  state.strategyStats.parityGrossPnl += plan.expectedGrossPnlUsd;
  state.strategyStats.parityNetPnlEstimate += (plan.estimatedNetEdgeBps / 10_000) * plan.sizeShares;
  state.strategyStats.lastParityTradeAt = new Date().toISOString();
}

function recordFailed(
  state: AlphaBotState,
  plan: AlphaParityPlan,
  mode: ParityMode,
  reason: string,
  txIds: string[] = [],
): void {
  state.parityAttempts.push(attempt(plan, mode, "failed", reason, txIds));
  state.strategyStats.parityFailedLegs += 1;
}

function planMessage(prefix: string, plan: AlphaParityPlan): string {
  const action = plan.type === "PARITY" ? "buy YES/NO then merge" : "split then sell YES/NO";
  return `${prefix} ${action} ${plan.title}: YES=${plan.yesPrice.toFixed(3)} NO=${plan.noPrice.toFixed(3)} size=${plan.sizeShares.toFixed(
    6,
  )} expectedGross=${formatUsd(plan.expectedGrossPnlUsd)} netEdge=${plan.estimatedNetEdgeBps.toFixed(0)}bps`;
}

function formatUsd(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(4)}`;
}

export function describeParityResidual(residual: ParityResidual): string {
  return `Parity residual (${residual.kind}) ${residual.title} appId=${residual.marketAppId}: ${residual.message}`;
}

/**
 * Pure planner for buy-merge mid-leg failure: after one side fills and the other
 * fails, unwind by market-selling the filled side. Used by execute path and tests.
 */
export function planBuyMergeUnwind(input: {
  filledOutcome: "YES" | "NO";
  failedLeg: string;
  marketAppId: number;
  title: string;
  shares: number;
  unwindSucceeded: boolean;
  unwindError?: string;
}): { residual?: ParityResidual; reason: string } {
  if (input.unwindSucceeded) {
    return {
      reason: `${input.failedLeg} failed after ${input.filledOutcome} fill; unwound ${input.filledOutcome} successfully`,
    };
  }
  const residual: ParityResidual = {
    kind: "buy_merge_one_side",
    marketAppId: input.marketAppId,
    title: input.title,
    shares: input.shares,
    outcome: input.filledOutcome,
    message: `${input.failedLeg} failed after ${input.filledOutcome} fill; unwind sell also failed (${input.unwindError ?? "unknown"}): stranded ${input.shares.toFixed(6)} ${input.filledOutcome}`,
  };
  return { residual, reason: residual.message };
}

/**
 * Pure planner for split-sell mid-leg failure: attempt merge-back of remaining
 * matched free sets; otherwise record an unmatched residual.
 */
export function planSplitSellResidual(input: {
  marketAppId: number;
  title: string;
  shares: number;
  failedLeg: string;
  mergeBackSucceeded: boolean;
  mergeBackError?: string;
}): { residual?: ParityResidual; reason: string } {
  if (input.mergeBackSucceeded) {
    return {
      reason: `${input.failedLeg} failed after split; merge-back of matched free sets succeeded`,
    };
  }
  const residual: ParityResidual = {
    kind: "split_sell_unmatched",
    marketAppId: input.marketAppId,
    title: input.title,
    shares: input.shares,
    message: `${input.failedLeg} failed after split; merge-back also failed (${input.mergeBackError ?? "unknown"}): stranded ~${input.shares.toFixed(6)} YES/NO from split`,
  };
  return { residual, reason: residual.message };
}

function validatePlan(
  plan: AlphaParityPlan,
  state: AlphaBotState,
  config: AlphaConfig,
  walletUsdcBalanceUsd: number | undefined,
  enforceWalletUsdc: boolean,
): string | undefined {
  if (plan.notionalUsd < config.parityMinTradeUsd) {
    return `trade notional $${plan.notionalUsd.toFixed(2)} below parity minimum $${config.parityMinTradeUsd.toFixed(2)}`;
  }
  if (plan.notionalUsd > config.parityMaxTradeUsd) {
    return `trade notional $${plan.notionalUsd.toFixed(2)} exceeds parity maximum $${config.parityMaxTradeUsd.toFixed(2)}`;
  }
  if (plan.notionalUsd < config.parityMinDepthUsd) {
    return `depth $${plan.notionalUsd.toFixed(2)} below parity minimum $${config.parityMinDepthUsd.toFixed(2)}`;
  }
  if (plan.estimatedNetEdgeBps < config.parityMinEdgeBps) {
    return `net edge ${plan.estimatedNetEdgeBps.toFixed(0)}bps below minimum ${config.parityMinEdgeBps.toFixed(0)}bps`;
  }
  if (dailyParityUsd(state) + plan.notionalUsd > config.parityMaxDailyUsd) {
    return `daily parity notional cap would exceed $${config.parityMaxDailyUsd.toFixed(2)}`;
  }
  if (!enforceWalletUsdc) return undefined;
  if (walletUsdcBalanceUsd === undefined) {
    return "wallet USDC unavailable; skipping live parity trade";
  }
  const requiredUsdc = plan.notionalUsd * (1 + config.liveBidUsdcBufferBps / 10_000);
  if (requiredUsdc > walletUsdcBalanceUsd) {
    return `wallet USDC ${walletUsdcBalanceUsd.toFixed(2)} below parity requirement ${requiredUsdc.toFixed(2)} including ${(
      config.liveBidUsdcBufferBps / 100
    ).toFixed(2)}% buffer`;
  }
  return undefined;
}

async function refreshPlan(
  liveClient: AlphaSdkClient,
  market: AlphaMarket,
  config: AlphaConfig,
  type: AlphaParityPlan["type"],
): Promise<AlphaParityPlan | undefined> {
  const book = await liveClient.getOrderbook(market);
  const plans = scanParity(
    [market],
    new Map<number, AlphaOrderbook>([[market.marketAppId, book]]),
    config,
  );
  return plans.find((plan) => plan.type === type);
}

async function executeBuyMerge(
  liveClient: AlphaSdkClient,
  plan: AlphaParityPlan,
  config: AlphaConfig,
): Promise<ParityExecuteResult> {
  const slippage = config.paritySlippageCents / 100;
  const txIds: string[] = [];

  try {
    const yes = await liveClient.createMarketOrder({
      marketAppId: plan.marketAppId,
      outcome: "YES",
      price: plan.yesPrice,
      sizeShares: plan.sizeShares,
      isBuying: true,
      slippage,
    });
    txIds.push(...yes.txIds);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, txIds, error: `YES buy failed: ${message}` };
  }

  try {
    const no = await liveClient.createMarketOrder({
      marketAppId: plan.marketAppId,
      outcome: "NO",
      price: plan.noPrice,
      sizeShares: plan.sizeShares,
      isBuying: true,
      slippage,
    });
    txIds.push(...no.txIds);
  } catch (error) {
    const failedMsg = error instanceof Error ? error.message : String(error);
    try {
      const unwind = await liveClient.createMarketOrder({
        marketAppId: plan.marketAppId,
        outcome: "YES",
        price: plan.yesPrice,
        sizeShares: plan.sizeShares,
        isBuying: false,
        slippage,
      });
      txIds.push(...unwind.txIds);
      const planned = planBuyMergeUnwind({
        filledOutcome: "YES",
        failedLeg: `NO buy (${failedMsg})`,
        marketAppId: plan.marketAppId,
        title: plan.title,
        shares: plan.sizeShares,
        unwindSucceeded: true,
      });
      return { ok: false, txIds, error: planned.reason };
    } catch (unwindError) {
      const unwindMsg = unwindError instanceof Error ? unwindError.message : String(unwindError);
      const planned = planBuyMergeUnwind({
        filledOutcome: "YES",
        failedLeg: `NO buy (${failedMsg})`,
        marketAppId: plan.marketAppId,
        title: plan.title,
        shares: plan.sizeShares,
        unwindSucceeded: false,
        unwindError: unwindMsg,
      });
      return { ok: false, txIds, residual: planned.residual, error: planned.reason };
    }
  }

  try {
    const merge = await liveClient.mergeShares({
      marketAppId: plan.marketAppId,
      amountShares: plan.sizeShares,
    });
    txIds.push(...merge.txIds);
    return { ok: true, txIds };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const residual: ParityResidual = {
      kind: "buy_merge_unmerged",
      marketAppId: plan.marketAppId,
      title: plan.title,
      shares: plan.sizeShares,
      message: `YES+NO bought but merge failed (${message}): stranded matched free sets (inventory merge may recover)`,
    };
    return { ok: false, txIds, residual, error: residual.message };
  }
}

async function executeSplitSell(
  liveClient: AlphaSdkClient,
  plan: AlphaParityPlan,
  config: AlphaConfig,
): Promise<ParityExecuteResult> {
  const slippage = config.paritySlippageCents / 100;
  const txIds: string[] = [];

  try {
    const split = await liveClient.splitShares({
      marketAppId: plan.marketAppId,
      amountUsd: plan.sizeShares,
    });
    txIds.push(...split.txIds);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, txIds, error: `split failed: ${message}` };
  }

  try {
    const yes = await liveClient.createMarketOrder({
      marketAppId: plan.marketAppId,
      outcome: "YES",
      price: plan.yesPrice,
      sizeShares: plan.sizeShares,
      isBuying: false,
      slippage,
    });
    txIds.push(...yes.txIds);
  } catch (error) {
    const failedMsg = error instanceof Error ? error.message : String(error);
    try {
      const mergeBack = await liveClient.mergeShares({
        marketAppId: plan.marketAppId,
        amountShares: plan.sizeShares,
      });
      txIds.push(...mergeBack.txIds);
      const planned = planSplitSellResidual({
        marketAppId: plan.marketAppId,
        title: plan.title,
        shares: plan.sizeShares,
        failedLeg: `YES sell (${failedMsg})`,
        mergeBackSucceeded: true,
      });
      return { ok: false, txIds, error: planned.reason };
    } catch (mergeError) {
      const mergeMsg = mergeError instanceof Error ? mergeError.message : String(mergeError);
      const planned = planSplitSellResidual({
        marketAppId: plan.marketAppId,
        title: plan.title,
        shares: plan.sizeShares,
        failedLeg: `YES sell (${failedMsg})`,
        mergeBackSucceeded: false,
        mergeBackError: mergeMsg,
      });
      return { ok: false, txIds, residual: planned.residual, error: planned.reason };
    }
  }

  try {
    const no = await liveClient.createMarketOrder({
      marketAppId: plan.marketAppId,
      outcome: "NO",
      price: plan.noPrice,
      sizeShares: plan.sizeShares,
      isBuying: false,
      slippage,
    });
    txIds.push(...no.txIds);
    return { ok: true, txIds };
  } catch (error) {
    const failedMsg = error instanceof Error ? error.message : String(error);
    // YES already sold; remaining NO cannot merge alone. Record residual.
    const residual: ParityResidual = {
      kind: "split_sell_unmatched",
      marketAppId: plan.marketAppId,
      title: plan.title,
      shares: plan.sizeShares,
      outcome: "NO",
      message: `NO sell failed after YES sell (${failedMsg}): stranded ${plan.sizeShares.toFixed(6)} NO from split`,
    };
    return { ok: false, txIds, residual, error: residual.message };
  }
}

export async function runParityLane(input: {
  scan: AlphaScanResult;
  state: AlphaBotState;
  config: AlphaConfig;
  liveClient: AlphaSdkClient;
  mode: ParityMode;
  walletUsdcBalanceUsd?: number;
}): Promise<ParityAction[]> {
  const { scan, state, config, liveClient, mode, walletUsdcBalanceUsd } = input;
  if (!config.enableParityLane) {
    return [{ kind: "skip", message: "Parity lane disabled (ALPHA_ENABLE_PARITY_LANE=false)" }];
  }
  const marketByAppId = new Map(
    [...scan.markets, ...scan.rewardMarkets].map((market) => [market.marketAppId, market]),
  );
  const plans = scanParity([...marketByAppId.values()], scan.orderbooks, config);
  const actions: ParityAction[] = [];
  if (plans.length === 0) {
    actions.push({ kind: "skip", message: "Parity: no executable depth-aware candidates" });
    return actions;
  }

  actions.push({
    kind: "parity",
    message: `Parity: ${plans.length} executable candidate(s) detected`,
  });
  const planWindow = plans.slice(0, Math.max(1, config.parityQueueLimit));
  for (const plan of planWindow) {
    const rejection = validatePlan(plan, state, config, walletUsdcBalanceUsd, mode === "live");
    if (rejection) {
      recordSkipped(state, plan, mode, rejection);
      actions.push({ kind: "skip", message: `Skipped parity ${plan.title}: ${rejection}` });
      continue;
    }
    if (mode === "live-dry-run") {
      state.parityAttempts.push(attempt(plan, mode, "planned", "dry-run"));
      actions.push({ kind: "parity", message: planMessage("Would", plan) });
      return actions;
    }
    if (!config.enableParityArb) {
      recordSkipped(state, plan, mode, "parity arb disabled");
      actions.push({
        kind: "skip",
        message: `Skipped parity ${plan.title}: ALPHA_ENABLE_PARITY_ARB=false`,
      });
      continue;
    }

    const market = marketByAppId.get(plan.marketAppId);
    if (!market) {
      recordSkipped(state, plan, mode, "market metadata unavailable");
      actions.push({
        kind: "skip",
        message: `Skipped parity ${plan.title}: market metadata unavailable`,
      });
      continue;
    }
    try {
      const refreshed = await refreshPlan(liveClient, market, config, plan.type);
      if (!refreshed) {
        recordSkipped(state, plan, mode, "candidate disappeared after orderbook refresh");
        actions.push({
          kind: "skip",
          message: `Skipped parity ${plan.title}: candidate disappeared after refresh`,
        });
        continue;
      }
      const result =
        refreshed.type === "PARITY"
          ? await executeBuyMerge(liveClient, refreshed, config)
          : await executeSplitSell(liveClient, refreshed, config);
      if (result.ok) {
        recordExecuted(state, refreshed, mode, result.txIds);
        actions.push({ kind: "parity", message: planMessage("Executed", refreshed) });
        // One successful parity trade per tick.
        return actions;
      }
      const reason = result.error ?? "parity execution failed";
      recordFailed(state, refreshed, mode, reason, result.txIds);
      actions.push({ kind: "skip", message: `Parity failed ${refreshed.title}: ${reason}` });
      if (result.residual) {
        actions.push({ kind: "parity", message: describeParityResidual(result.residual) });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      recordFailed(state, plan, mode, reason);
      actions.push({ kind: "skip", message: `Parity failed ${plan.title}: ${reason}` });
    }
  }
  return actions;
}
