import type { AccountancySnapshot } from "./accountancyLedgers.js";
import { buildAccountancySnapshot } from "./accountancyLedgers.js";
import type { AlphaConfig } from "./alphaConfig.js";
import { summarizeLiveExposure } from "./alphaFormatter.js";
import type { AlphaScanResult } from "./alphaMarketScanner.js";
import type { AlphaBotState } from "./alphaTypes.js";
import type { PaymentReceipt } from "../integrations/amarok/payment.js";
import type { LiveAction } from "./liveTrader.js";
import type { RewardRateContext } from "./rewardRateEstimator.js";
import {
  escapeHtml,
  escapeRichMarkdown,
  truncateHtmlReport,
  truncatePlainReport,
  truncateRichReport,
  type TelegramRichReport,
} from "./telegramNotifier.js";

const MAX_ACTION_ROWS = 8;

export type TelegramSpendInput = {
  payments?: Array<Pick<PaymentReceipt, "amountBaseUnits">>;
  inferenceCostLine?: string;
};

export type TickActionSummary = {
  placed: string[];
  cancelled: string[];
  inferredEntryFills: string[];
  inferredExitFills: string[];
  parityEvents: string[];
  recycleEvents: string[];
  warnings: string[];
};

type ExposureSummary = ReturnType<typeof summarizeLiveExposure>;

export type GhillieReportBaseInput = {
  state: AlphaBotState;
  walletUsdcBalanceUsd?: number;
  walletAlgoBalance?: number;
  config?: Pick<AlphaConfig, "rewardMinDwellSeconds" | "walletAddress" | "rewardRateCalibration">;
  rewardContext?: RewardRateContext;
  spend?: TelegramSpendInput;
  at?: string;
};

export type TickDigestInput = GhillieReportBaseInput & {
  actions: LiveAction[];
};

function formatUsd(value: number | undefined): string {
  if (value === undefined) return "unknown";
  return `$${value.toFixed(2)}`;
}

function formatRewardUsd(value: number | undefined): string {
  if (value === undefined) return "unknown";
  const decimals = Math.abs(value) < 0.01 ? 6 : 2;
  return `$${value.toFixed(decimals)}`;
}

function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  return `${(value * 100).toFixed(2)}%`;
}

function formatAlgo(value: number | undefined): string {
  return value === undefined ? "unknown" : value.toFixed(6);
}

function isLowBalanceWarning(message: string): boolean {
  return (
    message.includes("below safety floor") ||
    message.includes("below parity cost") ||
    message.includes("below split amount") ||
    message.includes("No live placements; wallet ALGO")
  );
}

export function summarizeTickActions(actions: LiveAction[]): TickActionSummary {
  const summary: TickActionSummary = {
    placed: [],
    cancelled: [],
    inferredEntryFills: [],
    inferredExitFills: [],
    parityEvents: [],
    recycleEvents: [],
    warnings: [],
  };

  for (const action of actions) {
    if (action.kind === "place") {
      summary.placed.push(action.message);
      continue;
    }
    if (action.kind === "cancel") {
      summary.cancelled.push(action.message);
      continue;
    }
    if (action.kind === "merge" || action.kind === "claim") {
      summary.recycleEvents.push(action.message);
      continue;
    }
    if (
      action.message.startsWith("Live entry fill") ||
      action.message.startsWith("Inferred live entry fill") ||
      action.message.startsWith("Inferred live fill")
    ) {
      summary.inferredEntryFills.push(action.message);
      continue;
    }
    if (action.message.startsWith("Live exit fill") || action.message.startsWith("Inferred live exit fill")) {
      summary.inferredExitFills.push(action.message);
      continue;
    }
    if (action.kind === "parity" || action.message.startsWith("Parity failed")) {
      summary.parityEvents.push(action.message);
      continue;
    }
    if (isLowBalanceWarning(action.message)) {
      summary.warnings.push(action.message);
    }
  }
  return summary;
}

/** Pull ZeroSignal inference line from plan-review skip actions when present. */
export function extractInferenceCostLine(actions: LiveAction[]): string | undefined {
  for (const action of actions) {
    if (action.message.startsWith("ZeroSignal inference:")) {
      return action.message;
    }
  }
  return undefined;
}

function buildAccountancy(input: GhillieReportBaseInput, exposure: ExposureSummary): AccountancySnapshot {
  const positionsValueUsd = Object.values(input.state.positionsByMarket).reduce((sum, position) => {
    const yesMark = position.lastMark ?? position.avgYesCost;
    const noMark = position.lastMark ?? position.avgNoCost;
    return sum + position.yesShares * yesMark + position.noShares * noMark;
  }, 0);
  return buildAccountancySnapshot({
    state: input.state,
    walletUsdc: input.walletUsdcBalanceUsd,
    bidEscrowUsd: exposure.bidExposureUsd,
    positionsValueUsd,
  });
}

function compactLines(lines: string[], maxItems = 2): string {
  if (lines.length === 0) return "none";
  const shown = lines.slice(0, maxItems).join(" | ");
  return lines.length > maxItems ? `${shown} | +${lines.length - maxItems} more` : shown;
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function buildSpendPlainLines(spend: TelegramSpendInput | undefined): string[] {
  if (!spend) return [];
  const lines: string[] = [];
  const payments = spend.payments ?? [];
  if (payments.length > 0) {
    const total = payments.reduce((sum, payment) => sum + BigInt(payment.amountBaseUnits), 0n);
    lines.push(`Amarok x402: ${payments.length} call(s), ${total.toString()} USDC base units`);
  }
  if (spend.inferenceCostLine) {
    lines.push(spend.inferenceCostLine);
  }
  return lines;
}

function buildSpendRichLines(spend: TelegramSpendInput | undefined): string[] {
  if (!spend) return [];
  const lines: string[] = [];
  const payments = spend.payments ?? [];
  if (payments.length > 0) {
    const total = payments.reduce((sum, payment) => sum + BigInt(payment.amountBaseUnits), 0n);
    lines.push(`Amarok x402: **${payments.length}** call(s), \`${total.toString()}\` USDC base units`);
  }
  if (spend.inferenceCostLine) {
    lines.push(escapeRichMarkdown(spend.inferenceCostLine));
  }
  return lines;
}

function buildSpendHtmlLines(spend: TelegramSpendInput | undefined): string[] {
  if (!spend) return [];
  const lines: string[] = [];
  const payments = spend.payments ?? [];
  if (payments.length > 0) {
    const total = payments.reduce((sum, payment) => sum + BigInt(payment.amountBaseUnits), 0n);
    lines.push(
      `Amarok x402: <b>${payments.length}</b> call(s), <code>${escapeHtml(total.toString())}</code> USDC base units`,
    );
  }
  if (spend.inferenceCostLine) {
    lines.push(escapeHtml(spend.inferenceCostLine));
  }
  return lines;
}

function actionRows(summary: TickActionSummary): Array<{ kind: string; detail: string }> {
  const rows: Array<{ kind: string; detail: string }> = [];
  for (const detail of summary.placed) rows.push({ kind: "place", detail });
  for (const detail of summary.cancelled) rows.push({ kind: "cancel", detail });
  for (const detail of summary.inferredEntryFills) rows.push({ kind: "entry fill", detail });
  for (const detail of summary.inferredExitFills) rows.push({ kind: "exit fill", detail });
  for (const detail of summary.recycleEvents) rows.push({ kind: "recycle", detail });
  for (const detail of summary.parityEvents) rows.push({ kind: "parity", detail });
  return rows.slice(0, MAX_ACTION_ROWS);
}

function mergeSpend(
  spend: TelegramSpendInput | undefined,
  actions: LiveAction[] | undefined,
): TelegramSpendInput | undefined {
  const inferenceCostLine = spend?.inferenceCostLine ?? (actions ? extractInferenceCostLine(actions) : undefined);
  const payments = spend?.payments;
  if ((!payments || payments.length === 0) && !inferenceCostLine) return undefined;
  return { payments, inferenceCostLine };
}

function snapshotLinesPlain(
  walletUsdcBalanceUsd: number | undefined,
  walletAlgoBalance: number | undefined,
  exposure: ExposureSummary,
): string[] {
  return [
    `Wallet: ${formatUsd(walletUsdcBalanceUsd)} USDC | ${formatAlgo(walletAlgoBalance)} ALGO`,
    `Orders: ${exposure.openOrders} open (${exposure.bidOrders} bid, ${exposure.exitOrders} exit) | Positions: ${exposure.openPositions} (${exposure.underwaterPositions} underwater)`,
  ];
}

function exposureLinesPlain(exposure: ExposureSummary, includeRealisedPlusOpen: boolean): string[] {
  const lines = [
    `Bid exposure: ${formatUsd(exposure.bidExposureUsd)} (reward ${formatUsd(exposure.rewardBidExposureUsd)}, eligible ${formatUsd(exposure.rewardEligibleBidExposureUsd)}, spread ${formatUsd(exposure.spreadBidExposureUsd)})`,
    `Exit notional: ${formatUsd(exposure.exitNotionalUsd)} (controlled ${formatUsd(exposure.controlledExitNotionalUsd)}, eligible ${formatUsd(exposure.rewardEligibleExitNotionalUsd)})`,
    `Underwater inventory: ${formatUsd(exposure.underwaterInventoryNotionalUsd)} (loss ${formatUsd(exposure.underwaterInventoryUnrealisedLossUsd)})`,
    includeRealisedPlusOpen
      ? `Exit if filled: ${formatUsd(exposure.exitPnlIfFilledUsd)} | Realised+open exit: ${formatUsd(exposure.realisedPlusOpenExitPnlUsd)}`
      : `Exit if filled: ${formatUsd(exposure.exitPnlIfFilledUsd)}`,
    `Reward rates: eligible liquidity ${formatUsd(exposure.rewardEligibleLiquidityUsd)} (${exposure.rewardEligibleOrders} ord) | active ${formatRewardUsd(exposure.activeRewardRateDailyUsd)}/day | potential ${formatRewardUsd(exposure.potentialRewardRateDailyUsd)}/day | share ${formatPercent(exposure.activeRewardLiquidityShare)}/${formatPercent(exposure.potentialRewardLiquidityShare)}`,
  ];
  return lines;
}

function accountancyLinesPlain(snapshot: AccountancySnapshot): string[] {
  return [
    `Trading: realised ${formatUsd(snapshot.trading.realisedPnlUsd)} | unrealised ${formatUsd(snapshot.trading.unrealisedPnlUsd)} | total ${formatUsd(snapshot.trading.tradingPnlUsd)}`,
    `Rewards: received ${formatRewardUsd(snapshot.rewards.receivedUsd)} | est accrual ${formatRewardUsd(snapshot.rewards.estimatedAccrualUsd)}`,
    `Cash: wallet ${formatUsd(snapshot.cash.walletUsdc)} | bid escrow ${formatUsd(snapshot.cash.bidEscrowUsd)} | total ${formatUsd(snapshot.cash.cashUsdc)}`,
    `Total economic (trading+rewards): ${formatUsd(snapshot.totalEconomicUsd)}`,
  ];
}

function formatTickDigestPlain(input: TickDigestInput): string {
  const exposure = summarizeLiveExposure(input.state, input.config, input.rewardContext ?? {});
  const accountancy = buildAccountancy(input, exposure);
  const actionSummary = summarizeTickActions(input.actions);
  const spend = mergeSpend(input.spend, input.actions);
  const tickAt = input.at ?? new Date().toISOString();
  const spendLines = buildSpendPlainLines(spend);

  const lines = [
    `Ghillie tick · ${tickAt}`,
    `Tick: placed=${actionSummary.placed.length} cancelled=${actionSummary.cancelled.length} entry_fills=${actionSummary.inferredEntryFills.length} exit_fills=${actionSummary.inferredExitFills.length}`,
    ...snapshotLinesPlain(input.walletUsdcBalanceUsd, input.walletAlgoBalance, exposure),
    ...exposureLinesPlain(exposure, false),
    ...accountancyLinesPlain(accountancy),
    `Spread PnL: ${formatUsd(input.state.strategyStats.spreadRealisedPnl)} | Parity PnL: ${formatUsd(input.state.strategyStats.parityGrossPnl)}`,
    `Placed: ${compactLines(actionSummary.placed)}`,
    `Closed/cancelled: ${compactLines([...actionSummary.cancelled, ...actionSummary.inferredExitFills])}`,
    `Recycled: ${compactLines(actionSummary.recycleEvents)}`,
    `Warnings: ${compactLines(actionSummary.warnings, 1)}`,
  ];
  if (spendLines.length > 0) {
    lines.push("Spend:", ...spendLines.map((line) => `  ${line}`));
  }
  return truncatePlainReport(lines.join("\n"));
}

function formatDailySummaryPlain(input: GhillieReportBaseInput): string {
  const exposure = summarizeLiveExposure(input.state, input.config, input.rewardContext ?? {});
  const accountancy = buildAccountancy(input, exposure);
  const spend = mergeSpend(input.spend, undefined);
  const date = input.at ?? new Date().toISOString().slice(0, 10);
  const spendLines = buildSpendPlainLines(spend);

  const lines = [
    `Ghillie daily · ${date}`,
    ...snapshotLinesPlain(input.walletUsdcBalanceUsd, input.walletAlgoBalance, exposure),
    ...exposureLinesPlain(exposure, true),
    ...accountancyLinesPlain(accountancy),
    `Spread PnL: ${formatUsd(input.state.strategyStats.spreadRealisedPnl)} | Parity PnL: ${formatUsd(input.state.strategyStats.parityGrossPnl)}`,
    `Lifetime: placed=${input.state.strategyStats.liveOrdersPlaced} cancelled=${input.state.strategyStats.liveOrdersCancelled}`,
  ];
  if (spendLines.length > 0) {
    lines.push("Spend:", ...spendLines.map((line) => `  ${line}`));
  }
  return truncatePlainReport(lines.join("\n"));
}

function formatTickDigestRich(input: TickDigestInput): string {
  const exposure = summarizeLiveExposure(input.state, input.config, input.rewardContext ?? {});
  const accountancy = buildAccountancy(input, exposure);
  const actionSummary = summarizeTickActions(input.actions);
  const spend = mergeSpend(input.spend, input.actions);
  const tickAt = input.at ?? new Date().toISOString();
  const rows = actionRows(actionSummary);
  const spendLines = buildSpendRichLines(spend);

  const sections: string[] = [
    `### Ghillie tick · ${tickAt}`,
    `**Placed** ${actionSummary.placed.length} · **Cancelled** ${actionSummary.cancelled.length} · **Entry fills** ${actionSummary.inferredEntryFills.length} · **Exit fills** ${actionSummary.inferredExitFills.length}`,
    `**Wallet** ${formatUsd(input.walletUsdcBalanceUsd)} USDC · **ALGO** ${formatAlgo(input.walletAlgoBalance)}`,
    `**Orders** ${exposure.openOrders} open (${exposure.bidOrders} bid, ${exposure.exitOrders} exit) · **Positions** ${exposure.openPositions} (${exposure.underwaterPositions} underwater)`,
    "",
    "### Exposure",
    `Bid **${formatUsd(exposure.bidExposureUsd)}** · reward ${formatUsd(exposure.rewardBidExposureUsd)} · eligible ${formatUsd(exposure.rewardEligibleBidExposureUsd)} · spread ${formatUsd(exposure.spreadBidExposureUsd)}`,
    `Exit notional **${formatUsd(exposure.exitNotionalUsd)}** · controlled ${formatUsd(exposure.controlledExitNotionalUsd)} · eligible ${formatUsd(exposure.rewardEligibleExitNotionalUsd)}`,
    `Underwater **${formatUsd(exposure.underwaterInventoryNotionalUsd)}** · loss ${formatUsd(exposure.underwaterInventoryUnrealisedLossUsd)}`,
    `Exit if filled **${formatUsd(exposure.exitPnlIfFilledUsd)}**`,
    `Rewards: eligible liquidity **${formatUsd(exposure.rewardEligibleLiquidityUsd)}** (${exposure.rewardEligibleOrders} ord) · active **${formatRewardUsd(exposure.activeRewardRateDailyUsd)}**/day · potential **${formatRewardUsd(exposure.potentialRewardRateDailyUsd)}**/day · share ${formatPercent(exposure.activeRewardLiquidityShare)}/${formatPercent(exposure.potentialRewardLiquidityShare)}`,
    "",
    "### Accountancy",
    `Trading realised **${formatUsd(accountancy.trading.realisedPnlUsd)}** · unrealised **${formatUsd(accountancy.trading.unrealisedPnlUsd)}** · total **${formatUsd(accountancy.trading.tradingPnlUsd)}**`,
    `Rewards received **${formatRewardUsd(accountancy.rewards.receivedUsd)}** · est accrual **${formatRewardUsd(accountancy.rewards.estimatedAccrualUsd)}**`,
    `Cash wallet **${formatUsd(accountancy.cash.walletUsdc)}** · bid escrow **${formatUsd(accountancy.cash.bidEscrowUsd)}** · total **${formatUsd(accountancy.cash.cashUsdc)}**`,
    `Total economic **${formatUsd(accountancy.totalEconomicUsd)}**`,
    `Spread PnL **${formatUsd(input.state.strategyStats.spreadRealisedPnl)}** · Parity PnL **${formatUsd(input.state.strategyStats.parityGrossPnl)}**`,
  ];

  if (rows.length > 0) {
    sections.push(
      "",
      "### Actions",
      "",
      "| Kind | Detail |",
      "| --- | --- |",
    );
    for (const row of rows) {
      sections.push(`| ${escapeRichMarkdown(row.kind)} | ${escapeRichMarkdown(truncate(row.detail, 120))} |`);
    }
    const total =
      actionSummary.placed.length +
      actionSummary.cancelled.length +
      actionSummary.inferredEntryFills.length +
      actionSummary.inferredExitFills.length +
      actionSummary.recycleEvents.length +
      actionSummary.parityEvents.length;
    if (total > MAX_ACTION_ROWS) {
      sections.push("", `_+${total - MAX_ACTION_ROWS} more action(s)_`);
    }
  }

  if (actionSummary.warnings.length > 0) {
    sections.push(
      "",
      "<details>",
      "<summary>Warnings</summary>",
      "",
      ...actionSummary.warnings.map((warning) => `- ${escapeRichMarkdown(truncate(warning, 240))}`),
      "",
      "</details>",
    );
  }

  if (spendLines.length > 0) {
    sections.push("", "### Spend", "", ...spendLines);
  }

  return truncateRichReport(sections.join("\n"));
}

function formatDailySummaryRich(input: GhillieReportBaseInput): string {
  const exposure = summarizeLiveExposure(input.state, input.config, input.rewardContext ?? {});
  const accountancy = buildAccountancy(input, exposure);
  const spend = mergeSpend(input.spend, undefined);
  const date = input.at ?? new Date().toISOString().slice(0, 10);
  const spendLines = buildSpendRichLines(spend);

  const sections: string[] = [
    `### Ghillie daily · ${date}`,
    `**Wallet** ${formatUsd(input.walletUsdcBalanceUsd)} USDC · **ALGO** ${formatAlgo(input.walletAlgoBalance)}`,
    `**Orders** ${exposure.openOrders} open (${exposure.bidOrders} bid, ${exposure.exitOrders} exit) · **Positions** ${exposure.openPositions} (${exposure.underwaterPositions} underwater)`,
    "",
    "### Exposure",
    `Bid **${formatUsd(exposure.bidExposureUsd)}** · reward ${formatUsd(exposure.rewardBidExposureUsd)} · eligible ${formatUsd(exposure.rewardEligibleBidExposureUsd)} · spread ${formatUsd(exposure.spreadBidExposureUsd)}`,
    `Exit notional **${formatUsd(exposure.exitNotionalUsd)}** · controlled ${formatUsd(exposure.controlledExitNotionalUsd)} · eligible ${formatUsd(exposure.rewardEligibleExitNotionalUsd)}`,
    `Underwater **${formatUsd(exposure.underwaterInventoryNotionalUsd)}** · loss ${formatUsd(exposure.underwaterInventoryUnrealisedLossUsd)}`,
    `Exit if filled **${formatUsd(exposure.exitPnlIfFilledUsd)}** · Realised+open exit **${formatUsd(exposure.realisedPlusOpenExitPnlUsd)}**`,
    `Rewards: eligible liquidity **${formatUsd(exposure.rewardEligibleLiquidityUsd)}** (${exposure.rewardEligibleOrders} ord) · active **${formatRewardUsd(exposure.activeRewardRateDailyUsd)}**/day · potential **${formatRewardUsd(exposure.potentialRewardRateDailyUsd)}**/day · share ${formatPercent(exposure.activeRewardLiquidityShare)}/${formatPercent(exposure.potentialRewardLiquidityShare)}`,
    "",
    "### Accountancy",
    `Trading realised **${formatUsd(accountancy.trading.realisedPnlUsd)}** · unrealised **${formatUsd(accountancy.trading.unrealisedPnlUsd)}** · total **${formatUsd(accountancy.trading.tradingPnlUsd)}**`,
    `Rewards received **${formatRewardUsd(accountancy.rewards.receivedUsd)}** · est accrual **${formatRewardUsd(accountancy.rewards.estimatedAccrualUsd)}**`,
    `Cash wallet **${formatUsd(accountancy.cash.walletUsdc)}** · bid escrow **${formatUsd(accountancy.cash.bidEscrowUsd)}** · total **${formatUsd(accountancy.cash.cashUsdc)}**`,
    `Total economic **${formatUsd(accountancy.totalEconomicUsd)}**`,
    `Spread PnL **${formatUsd(input.state.strategyStats.spreadRealisedPnl)}** · Parity PnL **${formatUsd(input.state.strategyStats.parityGrossPnl)}**`,
    `Lifetime placed **${input.state.strategyStats.liveOrdersPlaced}** · cancelled **${input.state.strategyStats.liveOrdersCancelled}**`,
  ];

  if (spendLines.length > 0) {
    sections.push("", "### Spend", "", ...spendLines);
  }

  return truncateRichReport(sections.join("\n"));
}

function formatTickDigestHtml(input: TickDigestInput): string {
  const exposure = summarizeLiveExposure(input.state, input.config, input.rewardContext ?? {});
  const accountancy = buildAccountancy(input, exposure);
  const actionSummary = summarizeTickActions(input.actions);
  const spend = mergeSpend(input.spend, input.actions);
  const tickAt = input.at ?? new Date().toISOString();
  const rows = actionRows(actionSummary);
  const spendLines = buildSpendHtmlLines(spend);

  const sections: string[] = [
    `<b>Ghillie tick · ${escapeHtml(tickAt)}</b>`,
    `<b>Placed</b> ${actionSummary.placed.length} · <b>Cancelled</b> ${actionSummary.cancelled.length} · <b>Entry fills</b> ${actionSummary.inferredEntryFills.length} · <b>Exit fills</b> ${actionSummary.inferredExitFills.length}`,
    `<b>Wallet</b> ${escapeHtml(formatUsd(input.walletUsdcBalanceUsd))} USDC · <b>ALGO</b> ${escapeHtml(formatAlgo(input.walletAlgoBalance))}`,
    `<b>Orders</b> ${exposure.openOrders} open (${exposure.bidOrders} bid, ${exposure.exitOrders} exit) · <b>Positions</b> ${exposure.openPositions} (${exposure.underwaterPositions} underwater)`,
    "",
    "<b>Exposure</b>",
    `Bid <b>${escapeHtml(formatUsd(exposure.bidExposureUsd))}</b> · reward ${escapeHtml(formatUsd(exposure.rewardBidExposureUsd))} · eligible ${escapeHtml(formatUsd(exposure.rewardEligibleBidExposureUsd))} · spread ${escapeHtml(formatUsd(exposure.spreadBidExposureUsd))}`,
    `Exit notional <b>${escapeHtml(formatUsd(exposure.exitNotionalUsd))}</b> · controlled ${escapeHtml(formatUsd(exposure.controlledExitNotionalUsd))} · eligible ${escapeHtml(formatUsd(exposure.rewardEligibleExitNotionalUsd))}`,
    `Underwater <b>${escapeHtml(formatUsd(exposure.underwaterInventoryNotionalUsd))}</b> · loss ${escapeHtml(formatUsd(exposure.underwaterInventoryUnrealisedLossUsd))}`,
    `Exit if filled <b>${escapeHtml(formatUsd(exposure.exitPnlIfFilledUsd))}</b>`,
    `Rewards: eligible liquidity <b>${escapeHtml(formatUsd(exposure.rewardEligibleLiquidityUsd))}</b> (${exposure.rewardEligibleOrders} ord) · active <b>${escapeHtml(formatRewardUsd(exposure.activeRewardRateDailyUsd))}</b>/day · potential <b>${escapeHtml(formatRewardUsd(exposure.potentialRewardRateDailyUsd))}</b>/day`,
    "",
    "<b>Accountancy</b>",
    `Trading realised <b>${escapeHtml(formatUsd(accountancy.trading.realisedPnlUsd))}</b> · unrealised <b>${escapeHtml(formatUsd(accountancy.trading.unrealisedPnlUsd))}</b> · total <b>${escapeHtml(formatUsd(accountancy.trading.tradingPnlUsd))}</b>`,
    `Rewards received <b>${escapeHtml(formatRewardUsd(accountancy.rewards.receivedUsd))}</b> · est accrual <b>${escapeHtml(formatRewardUsd(accountancy.rewards.estimatedAccrualUsd))}</b>`,
    `Cash wallet <b>${escapeHtml(formatUsd(accountancy.cash.walletUsdc))}</b> · bid escrow <b>${escapeHtml(formatUsd(accountancy.cash.bidEscrowUsd))}</b> · total <b>${escapeHtml(formatUsd(accountancy.cash.cashUsdc))}</b>`,
    `Total economic <b>${escapeHtml(formatUsd(accountancy.totalEconomicUsd))}</b>`,
    `Spread PnL <b>${escapeHtml(formatUsd(input.state.strategyStats.spreadRealisedPnl))}</b> · Parity PnL <b>${escapeHtml(formatUsd(input.state.strategyStats.parityGrossPnl))}</b>`,
  ];

  if (rows.length > 0) {
    sections.push("", "<b>Actions</b>");
    for (const row of rows) {
      sections.push(`• <i>${escapeHtml(row.kind)}</i> — ${escapeHtml(truncate(row.detail, 120))}`);
    }
  }

  if (actionSummary.warnings.length > 0) {
    sections.push("", "<b>Warnings</b>");
    for (const warning of actionSummary.warnings) {
      sections.push(`• ${escapeHtml(truncate(warning, 240))}`);
    }
  }

  if (spendLines.length > 0) {
    sections.push("", "<b>Spend</b>", ...spendLines);
  }

  return truncateHtmlReport(sections.join("\n"));
}

function formatDailySummaryHtml(input: GhillieReportBaseInput): string {
  const exposure = summarizeLiveExposure(input.state, input.config, input.rewardContext ?? {});
  const accountancy = buildAccountancy(input, exposure);
  const spend = mergeSpend(input.spend, undefined);
  const date = input.at ?? new Date().toISOString().slice(0, 10);
  const spendLines = buildSpendHtmlLines(spend);

  const sections: string[] = [
    `<b>Ghillie daily · ${escapeHtml(date)}</b>`,
    `<b>Wallet</b> ${escapeHtml(formatUsd(input.walletUsdcBalanceUsd))} USDC · <b>ALGO</b> ${escapeHtml(formatAlgo(input.walletAlgoBalance))}`,
    `<b>Orders</b> ${exposure.openOrders} open (${exposure.bidOrders} bid, ${exposure.exitOrders} exit) · <b>Positions</b> ${exposure.openPositions} (${exposure.underwaterPositions} underwater)`,
    "",
    "<b>Exposure</b>",
    `Bid <b>${escapeHtml(formatUsd(exposure.bidExposureUsd))}</b> · reward ${escapeHtml(formatUsd(exposure.rewardBidExposureUsd))} · eligible ${escapeHtml(formatUsd(exposure.rewardEligibleBidExposureUsd))} · spread ${escapeHtml(formatUsd(exposure.spreadBidExposureUsd))}`,
    `Exit notional <b>${escapeHtml(formatUsd(exposure.exitNotionalUsd))}</b> · controlled ${escapeHtml(formatUsd(exposure.controlledExitNotionalUsd))} · eligible ${escapeHtml(formatUsd(exposure.rewardEligibleExitNotionalUsd))}`,
    `Underwater <b>${escapeHtml(formatUsd(exposure.underwaterInventoryNotionalUsd))}</b> · loss ${escapeHtml(formatUsd(exposure.underwaterInventoryUnrealisedLossUsd))}`,
    `Exit if filled <b>${escapeHtml(formatUsd(exposure.exitPnlIfFilledUsd))}</b> · Realised+open exit <b>${escapeHtml(formatUsd(exposure.realisedPlusOpenExitPnlUsd))}</b>`,
    `Rewards: eligible liquidity <b>${escapeHtml(formatUsd(exposure.rewardEligibleLiquidityUsd))}</b> (${exposure.rewardEligibleOrders} ord) · active <b>${escapeHtml(formatRewardUsd(exposure.activeRewardRateDailyUsd))}</b>/day · potential <b>${escapeHtml(formatRewardUsd(exposure.potentialRewardRateDailyUsd))}</b>/day`,
    "",
    "<b>Accountancy</b>",
    `Trading realised <b>${escapeHtml(formatUsd(accountancy.trading.realisedPnlUsd))}</b> · unrealised <b>${escapeHtml(formatUsd(accountancy.trading.unrealisedPnlUsd))}</b> · total <b>${escapeHtml(formatUsd(accountancy.trading.tradingPnlUsd))}</b>`,
    `Rewards received <b>${escapeHtml(formatRewardUsd(accountancy.rewards.receivedUsd))}</b> · est accrual <b>${escapeHtml(formatRewardUsd(accountancy.rewards.estimatedAccrualUsd))}</b>`,
    `Cash wallet <b>${escapeHtml(formatUsd(accountancy.cash.walletUsdc))}</b> · bid escrow <b>${escapeHtml(formatUsd(accountancy.cash.bidEscrowUsd))}</b> · total <b>${escapeHtml(formatUsd(accountancy.cash.cashUsdc))}</b>`,
    `Total economic <b>${escapeHtml(formatUsd(accountancy.totalEconomicUsd))}</b>`,
    `Spread PnL <b>${escapeHtml(formatUsd(input.state.strategyStats.spreadRealisedPnl))}</b> · Parity PnL <b>${escapeHtml(formatUsd(input.state.strategyStats.parityGrossPnl))}</b>`,
    `Lifetime placed <b>${input.state.strategyStats.liveOrdersPlaced}</b> · cancelled <b>${input.state.strategyStats.liveOrdersCancelled}</b>`,
  ];

  if (spendLines.length > 0) {
    sections.push("", "<b>Spend</b>", ...spendLines);
  }

  return truncateHtmlReport(sections.join("\n"));
}

export function formatTickDigestReport(input: TickDigestInput): TelegramRichReport {
  return {
    rich: formatTickDigestRich(input),
    html: formatTickDigestHtml(input),
    plain: formatTickDigestPlain(input),
  };
}

export function formatDailySummaryReport(input: GhillieReportBaseInput): TelegramRichReport {
  return {
    rich: formatDailySummaryRich(input),
    html: formatDailySummaryHtml(input),
    plain: formatDailySummaryPlain(input),
  };
}

export function rewardContextFromScan(scan: AlphaScanResult, walletAddress?: string): RewardRateContext {
  return {
    markets: [...scan.rewardMarkets, ...scan.markets],
    orderbooks: scan.orderbooks,
    walletAddress,
  };
}
