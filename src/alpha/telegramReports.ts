import type { PaymentReceipt } from "../integrations/amarok/payment.js";
import type { AccountancySnapshot } from "./accountancyLedgers.js";
import { buildAccountancySnapshot } from "./accountancyLedgers.js";
import type { AlphaConfig } from "./alphaConfig.js";
import { summarizeLiveExposure } from "./alphaFormatter.js";
import type { AlphaScanResult } from "./alphaMarketScanner.js";
import type { AlphaBotState } from "./alphaTypes.js";
import type { LiveAction } from "./liveTrader.js";
import type { RewardRateContext } from "./rewardRateEstimator.js";
import {
  escapeHtml,
  escapeRichMarkdown,
  type TelegramRichReport,
  truncateHtmlReport,
  truncatePlainReport,
  truncateRichReport,
} from "./telegramNotifier.js";
import {
  formatAmarokX402DailyLine,
  formatAmarokX402ThisRunLine,
  sumPaymentBaseUnits,
  type X402SpendLane,
} from "./x402Spend.js";

const MAX_ACTION_ROWS = 8;
const TICK_START_PLAIN = "======== Ghillie tick ========";
const TICK_END_PLAIN = "======== end tick ========";
const TICK_START_RICH = "━━ Ghillie tick ━━";
const TICK_END_RICH = "━━ end tick ━━";

export type TelegramSpendInput = {
  payments?: Array<Pick<PaymentReceipt, "amountBaseUnits">>;
  inferenceCostLine?: string;
  /** UTC daily Amarok x402 used + remaining (from bot-state counters). */
  daily?: X402SpendLane;
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
type TableRow = [string, string];

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

function padCell(value: string, width: number, align: "left" | "right" = "left"): string {
  if (value.length >= width) return value;
  const padding = " ".repeat(width - value.length);
  return align === "right" ? `${padding}${value}` : `${value}${padding}`;
}

function formatAlignedTable(headers: [string, string], rows: TableRow[]): string {
  const width0 = Math.max(headers[0].length, ...rows.map((row) => row[0].length));
  const width1 = Math.max(headers[1].length, ...rows.map((row) => row[1].length));
  const lines = [
    `${padCell(headers[0], width0)}  ${padCell(headers[1], width1, "right")}`,
    `${"-".repeat(width0)}  ${"-".repeat(width1)}`,
    ...rows.map((row) => `${padCell(row[0], width0)}  ${padCell(row[1], width1, "right")}`),
  ];
  return lines.join("\n");
}

function formatRichMarkdownTable(headers: [string, string], rows: TableRow[]): string[] {
  return [
    `| ${headers[0]} | ${headers[1]} |`,
    "| --- | ---: |",
    ...rows.map((row) => `| ${escapeRichMarkdown(row[0])} | ${escapeRichMarkdown(row[1])} |`),
  ];
}

function formatHtmlPreTable(headers: [string, string], rows: TableRow[]): string {
  return `<pre>${escapeHtml(formatAlignedTable(headers, rows))}</pre>`;
}

function actionCountRows(summary: TickActionSummary): TableRow[] {
  return [
    ["Placed", String(summary.placed.length)],
    ["Cancelled", String(summary.cancelled.length)],
    ["Entry fills", String(summary.inferredEntryFills.length)],
    ["Exit fills", String(summary.inferredExitFills.length)],
  ];
}

function bidExposureRows(exposure: ExposureSummary): TableRow[] {
  return [
    ["Total bid", formatUsd(exposure.bidExposureUsd)],
    ["Reward", formatUsd(exposure.rewardBidExposureUsd)],
    ["Eligible", formatUsd(exposure.rewardEligibleBidExposureUsd)],
    ["Spread", formatUsd(exposure.spreadBidExposureUsd)],
  ];
}

function exitExposureRows(exposure: ExposureSummary, includeRealisedPlusOpen: boolean): TableRow[] {
  const rows: TableRow[] = [
    ["Exit notional", formatUsd(exposure.exitNotionalUsd)],
    ["Controlled", formatUsd(exposure.controlledExitNotionalUsd)],
    ["Eligible exit", formatUsd(exposure.rewardEligibleExitNotionalUsd)],
    ["Underwater", formatUsd(exposure.underwaterInventoryNotionalUsd)],
    ["UW loss", formatUsd(exposure.underwaterInventoryUnrealisedLossUsd)],
    ["Exit if filled", formatUsd(exposure.exitPnlIfFilledUsd)],
  ];
  if (includeRealisedPlusOpen) {
    rows.push(["Realised+open exit", formatUsd(exposure.realisedPlusOpenExitPnlUsd)]);
  }
  return rows;
}

function rewardRateRows(exposure: ExposureSummary): TableRow[] {
  return [
    [
      "Eligible liq",
      `${formatUsd(exposure.rewardEligibleLiquidityUsd)} (${exposure.rewardEligibleOrders} ord)`,
    ],
    ["Active /day", formatRewardUsd(exposure.activeRewardRateDailyUsd)],
    ["Potential /day", formatRewardUsd(exposure.potentialRewardRateDailyUsd)],
    [
      "Share act/pot",
      `${formatPercent(exposure.activeRewardLiquidityShare)} / ${formatPercent(exposure.potentialRewardLiquidityShare)}`,
    ],
  ];
}

function accountancyRows(snapshot: AccountancySnapshot, state: AlphaBotState): TableRow[] {
  return [
    ["Trading realised", formatUsd(snapshot.trading.realisedPnlUsd)],
    ["Trading unrealised", formatUsd(snapshot.trading.unrealisedPnlUsd)],
    ["Trading total", formatUsd(snapshot.trading.tradingPnlUsd)],
    ["Rewards received", formatRewardUsd(snapshot.rewards.receivedUsd)],
    ["Rewards accrual", formatRewardUsd(snapshot.rewards.estimatedAccrualUsd)],
    ["Cash wallet", formatUsd(snapshot.cash.walletUsdc)],
    ["Bid escrow", formatUsd(snapshot.cash.bidEscrowUsd)],
    ["Cash total", formatUsd(snapshot.cash.cashUsdc)],
    ["Total economic", formatUsd(snapshot.totalEconomicUsd)],
    ["Spread PnL", formatUsd(state.strategyStats.spreadRealisedPnl)],
    ["Parity PnL", formatUsd(state.strategyStats.parityGrossPnl)],
  ];
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
    if (
      action.message.startsWith("Live exit fill") ||
      action.message.startsWith("Inferred live exit fill")
    ) {
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

function buildAccountancy(
  input: GhillieReportBaseInput,
  exposure: ExposureSummary,
): AccountancySnapshot {
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
    lines.push(
      formatAmarokX402ThisRunLine(payments.length, sumPaymentBaseUnits(payments), "plain"),
    );
  }
  if (spend.daily) {
    lines.push(formatAmarokX402DailyLine(spend.daily, "plain"));
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
    lines.push(formatAmarokX402ThisRunLine(payments.length, sumPaymentBaseUnits(payments), "rich"));
  }
  if (spend.daily) {
    lines.push(formatAmarokX402DailyLine(spend.daily, "rich"));
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
    lines.push(formatAmarokX402ThisRunLine(payments.length, sumPaymentBaseUnits(payments), "html"));
  }
  if (spend.daily) {
    lines.push(formatAmarokX402DailyLine(spend.daily, "html"));
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
  const inferenceCostLine =
    spend?.inferenceCostLine ?? (actions ? extractInferenceCostLine(actions) : undefined);
  const payments = spend?.payments;
  const daily = spend?.daily;
  if ((!payments || payments.length === 0) && !inferenceCostLine && !daily) return undefined;
  return { payments, inferenceCostLine, daily };
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

function formatTickDigestPlain(input: TickDigestInput): string {
  const exposure = summarizeLiveExposure(input.state, input.config, input.rewardContext ?? {});
  const accountancy = buildAccountancy(input, exposure);
  const actionSummary = summarizeTickActions(input.actions);
  const spend = mergeSpend(input.spend, input.actions);
  const tickAt = input.at ?? new Date().toISOString();
  const spendLines = buildSpendPlainLines(spend);
  const detailRows = actionRows(actionSummary);

  const lines = [
    TICK_START_PLAIN,
    tickAt,
    "",
    "Actions:",
    formatAlignedTable(["Action", "Count"], actionCountRows(actionSummary)),
    "",
    ...snapshotLinesPlain(input.walletUsdcBalanceUsd, input.walletAlgoBalance, exposure),
    "",
    "Bids:",
    formatAlignedTable(["Lane", "Bid"], bidExposureRows(exposure)),
    "",
    "Exit / inventory:",
    formatAlignedTable(["Metric", "Value"], exitExposureRows(exposure, false)),
    "",
    "Rewards:",
    formatAlignedTable(["Metric", "Value"], rewardRateRows(exposure)),
    "",
    "Accountancy:",
    formatAlignedTable(["Ledger", "Value"], accountancyRows(accountancy, input.state)),
  ];

  if (detailRows.length > 0) {
    lines.push(
      "",
      "Action details:",
      formatAlignedTable(
        ["Kind", "Detail"],
        detailRows.map((row) => [row.kind, truncate(row.detail, 80)]),
      ),
    );
  }

  if (actionSummary.warnings.length > 0) {
    lines.push("", `Warnings: ${compactLines(actionSummary.warnings, 1)}`);
  }

  if (spendLines.length > 0) {
    lines.push("", "Spend:", ...spendLines.map((line) => `  ${line}`));
  }

  lines.push("", TICK_END_PLAIN);
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
    "",
    "Bids:",
    formatAlignedTable(["Lane", "Bid"], bidExposureRows(exposure)),
    "",
    "Exit / inventory:",
    formatAlignedTable(["Metric", "Value"], exitExposureRows(exposure, true)),
    "",
    "Rewards:",
    formatAlignedTable(["Metric", "Value"], rewardRateRows(exposure)),
    "",
    "Accountancy:",
    formatAlignedTable(["Ledger", "Value"], accountancyRows(accountancy, input.state)),
    `Lifetime: placed=${input.state.strategyStats.liveOrdersPlaced} cancelled=${input.state.strategyStats.liveOrdersCancelled}`,
  ];
  if (spendLines.length > 0) {
    lines.push("", "Spend:", ...spendLines.map((line) => `  ${line}`));
  }
  return truncatePlainReport(lines.join("\n"));
}

function formatTickDigestRich(input: TickDigestInput): string {
  const exposure = summarizeLiveExposure(input.state, input.config, input.rewardContext ?? {});
  const accountancy = buildAccountancy(input, exposure);
  const actionSummary = summarizeTickActions(input.actions);
  const spend = mergeSpend(input.spend, input.actions);
  const tickAt = input.at ?? new Date().toISOString();
  const detailRows = actionRows(actionSummary);
  const spendLines = buildSpendRichLines(spend);

  const sections: string[] = [
    `### ${TICK_START_RICH}`,
    `\`${tickAt}\``,
    "",
    "### Actions",
    "",
    ...formatRichMarkdownTable(["Action", "Count"], actionCountRows(actionSummary)),
    "",
    `**Wallet** ${formatUsd(input.walletUsdcBalanceUsd)} USDC · **ALGO** ${formatAlgo(input.walletAlgoBalance)}`,
    `**Orders** ${exposure.openOrders} open (${exposure.bidOrders} bid, ${exposure.exitOrders} exit) · **Positions** ${exposure.openPositions} (${exposure.underwaterPositions} underwater)`,
    "",
    "### Bids",
    "",
    ...formatRichMarkdownTable(["Lane", "Bid"], bidExposureRows(exposure)),
    "",
    "### Exit / inventory",
    "",
    ...formatRichMarkdownTable(["Metric", "Value"], exitExposureRows(exposure, false)),
    "",
    "### Rewards",
    "",
    ...formatRichMarkdownTable(["Metric", "Value"], rewardRateRows(exposure)),
    "",
    "### Accountancy",
    "",
    ...formatRichMarkdownTable(["Ledger", "Value"], accountancyRows(accountancy, input.state)),
  ];

  if (detailRows.length > 0) {
    sections.push("", "### Action details", "", "| Kind | Detail |", "| --- | --- |");
    for (const row of detailRows) {
      sections.push(
        `| ${escapeRichMarkdown(row.kind)} | ${escapeRichMarkdown(truncate(row.detail, 120))} |`,
      );
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

  sections.push("", `### ${TICK_END_RICH}`);
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
    "### Bids",
    "",
    ...formatRichMarkdownTable(["Lane", "Bid"], bidExposureRows(exposure)),
    "",
    "### Exit / inventory",
    "",
    ...formatRichMarkdownTable(["Metric", "Value"], exitExposureRows(exposure, true)),
    "",
    "### Rewards",
    "",
    ...formatRichMarkdownTable(["Metric", "Value"], rewardRateRows(exposure)),
    "",
    "### Accountancy",
    "",
    ...formatRichMarkdownTable(["Ledger", "Value"], accountancyRows(accountancy, input.state)),
    "",
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
  const detailRows = actionRows(actionSummary);
  const spendLines = buildSpendHtmlLines(spend);

  const sections: string[] = [
    `<b>${escapeHtml(TICK_START_RICH)}</b>`,
    `<code>${escapeHtml(tickAt)}</code>`,
    "",
    "<b>Actions</b>",
    formatHtmlPreTable(["Action", "Count"], actionCountRows(actionSummary)),
    `<b>Wallet</b> ${escapeHtml(formatUsd(input.walletUsdcBalanceUsd))} USDC · <b>ALGO</b> ${escapeHtml(formatAlgo(input.walletAlgoBalance))}`,
    `<b>Orders</b> ${exposure.openOrders} open (${exposure.bidOrders} bid, ${exposure.exitOrders} exit) · <b>Positions</b> ${exposure.openPositions} (${exposure.underwaterPositions} underwater)`,
    "",
    "<b>Bids</b>",
    formatHtmlPreTable(["Lane", "Bid"], bidExposureRows(exposure)),
    "<b>Exit / inventory</b>",
    formatHtmlPreTable(["Metric", "Value"], exitExposureRows(exposure, false)),
    "<b>Rewards</b>",
    formatHtmlPreTable(["Metric", "Value"], rewardRateRows(exposure)),
    "<b>Accountancy</b>",
    formatHtmlPreTable(["Ledger", "Value"], accountancyRows(accountancy, input.state)),
  ];

  if (detailRows.length > 0) {
    sections.push(
      "",
      "<b>Action details</b>",
      formatHtmlPreTable(
        ["Kind", "Detail"],
        detailRows.map((row) => [row.kind, truncate(row.detail, 80)]),
      ),
    );
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

  sections.push("", `<b>${escapeHtml(TICK_END_RICH)}</b>`);
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
    "<b>Bids</b>",
    formatHtmlPreTable(["Lane", "Bid"], bidExposureRows(exposure)),
    "<b>Exit / inventory</b>",
    formatHtmlPreTable(["Metric", "Value"], exitExposureRows(exposure, true)),
    "<b>Rewards</b>",
    formatHtmlPreTable(["Metric", "Value"], rewardRateRows(exposure)),
    "<b>Accountancy</b>",
    formatHtmlPreTable(["Ledger", "Value"], accountancyRows(accountancy, input.state)),
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

export function rewardContextFromScan(
  scan: AlphaScanResult,
  walletAddress?: string,
): RewardRateContext {
  return {
    markets: [...scan.rewardMarkets, ...scan.markets],
    orderbooks: scan.orderbooks,
    walletAddress,
  };
}
