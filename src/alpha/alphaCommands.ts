import algosdk from "algosdk";
import dotenv from "dotenv";
import { isDebugModeEnabled } from "../utils/debugMode.js";
import { AlphaSdkClient } from "./alphaClient.js";
import type { AlphaConfig } from "./alphaConfig.js";
import {
  printLiveSummary,
  printMarketDetail,
  printPaperReport,
  printPaperWatch,
  printRewards,
  printScan,
  summarizeLiveExposure,
} from "./alphaFormatter.js";
import { type AlphaScanResult, loadAlphaScan, loadAmarokMarket } from "./alphaMarketScanner.js";
import { scanParity } from "./alphaParityScanner.js";
import { runResolvedAssetCleanup } from "./alphaResolvedAssetCleanup.js";
import { rankRewardCandidates } from "./alphaRewardScanner.js";
import { loadAlphaState, saveAlphaState } from "./alphaStateStore.js";
import type { AlphaBotState } from "./alphaTypes.js";
import {
  ALPHA_REWARD_HISTORY_SENDER,
  buildCapitalLedger,
  mergeCapitalLedgerIntoState,
  printCapitalLedgerReport,
} from "./capitalLedger.js";
import { formatMicroUsdc, scanWalletUsdcTransfers } from "./indexerTransfers.js";
import { loadAlphaConfig } from "./laneOverrideStore.js";
import type { LiveAction } from "./liveTrader.js";
import { runLiveTick } from "./liveTrader.js";
import { loadPaperReport, runPaperTick } from "./paperTrader.js";
import {
  notifyTelegramReport,
  notifyTelegramThrottled,
  readSkipNoticeThrottleMinutes,
} from "./telegramNotifier.js";
import {
  formatDailySummaryReport,
  formatTickDigestReport,
  rewardContextFromScan,
} from "./telegramReports.js";
import {
  applyX402PaymentsToState,
  formatAmarokX402ThisRunLine,
  formatDailySpendLines,
  persistX402SpendCounters,
  sumPaymentBaseUnits,
  toX402SpendReport,
} from "./x402Spend.js";

dotenv.config();

const DEFAULT_REWARD_HISTORY_RECEIVER =
  "65GJKPMEYLR2C2GHFIAUKF2CFDE6IXDB3LUTOVJ424LBMMEWJ6UXCHCBZQ";

async function runRewardHistoryCommand(
  receiverArg: string | undefined,
  senderArg: string | undefined,
): Promise<void> {
  const config = await loadAlphaConfig();
  const receiver = (
    receiverArg ||
    process.env.ALPHA_REWARD_HISTORY_RECEIVER ||
    DEFAULT_REWARD_HISTORY_RECEIVER
  ).trim();
  const sender = (senderArg || ALPHA_REWARD_HISTORY_SENDER).trim();
  if (!algosdk.isValidAddress(receiver)) {
    throw new Error(`Invalid Algorand receiver address for rewards history: ${receiver}`);
  }
  if (!algosdk.isValidAddress(sender)) {
    throw new Error(`Invalid Algorand sender address for rewards history: ${sender}`);
  }

  const scan = await scanWalletUsdcTransfers(receiver, config);
  let incomingTransferCount = 0;
  let incomingTotalMicroUsdc = 0n;
  let rewardTransferCount = 0;
  let rewardTotalMicroUsdc = 0n;

  for (const transfer of scan.transfers) {
    if (transfer.direction !== "in") continue;
    incomingTotalMicroUsdc += transfer.amountMicroUsdc;
    incomingTransferCount += 1;
    if (transfer.sender === sender) {
      rewardTotalMicroUsdc += transfer.amountMicroUsdc;
      rewardTransferCount += 1;
    }
  }

  console.log("GHILLIE ALPHA REWARD HISTORY");
  console.log("");
  console.log(`Receiver: ${receiver}`);
  console.log(`Reward sender filter: ${sender}`);
  console.log(`USDC asset ID: ${config.usdcAssetId}`);
  console.log(`Pages scanned: ${scan.pagesScanned}`);
  console.log(`Transactions gathered before filtering: ${scan.transactionsScanned}`);
  console.log(`Incoming USDC transfers (all senders): ${incomingTransferCount}`);
  console.log(`Incoming USDC total (all senders): ${formatMicroUsdc(incomingTotalMicroUsdc)}`);
  console.log(`Reward transfers (filtered sender): ${rewardTransferCount}`);
  console.log(`Total rewards received: ${formatMicroUsdc(rewardTotalMicroUsdc)}`);
}

async function runCapitalReportCommand(): Promise<void> {
  const config = await loadAlphaConfig();
  const walletAddress = config.walletAddress;
  if (!walletAddress || !algosdk.isValidAddress(walletAddress)) {
    throw new Error(
      "ALPHA_WALLET_ADDRESS or a mnemonic-derived address is required for capital-report",
    );
  }

  const client = new AlphaSdkClient(config, false);
  const state = await loadAlphaState(config.stateKey, config.paperStartingBalanceUsd);
  const scan = await loadAlphaScan(config);
  const markets = [
    ...new Map(
      [...scan.rewardMarkets, ...scan.markets].map((market) => [market.marketAppId, market]),
    ).values(),
  ];
  const marketAppIds = markets.map((market) => market.marketAppId);

  let walletUsdc: number | undefined;
  let walletOrders: Awaited<ReturnType<AlphaSdkClient["getWalletOpenOrders"]>> | undefined;
  try {
    walletUsdc = await client.getUsdcBalance(walletAddress);
  } catch (error) {
    console.warn(
      `Wallet USDC unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    walletOrders = await client.getWalletOpenOrders(walletAddress);
  } catch (error) {
    console.warn(
      `Wallet open orders unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const exposure = summarizeLiveExposure(state, config, { walletAddress });
  const escrowAppIds = [
    ...state.openOrders
      .filter((order) => order.status === "open" && order.liveEscrowAppId !== undefined)
      .map((order) => order.liveEscrowAppId as number),
    ...(walletOrders ?? []).map((order) => order.escrowAppId),
  ];

  const ledger = await buildCapitalLedger({
    config,
    walletAddress,
    walletUsdc,
    bidEscrowUsd: exposure.bidExposureUsd,
    positions: Object.values(state.positionsByMarket).flatMap((position) => {
      const rows: Array<{ valueUsd?: number; lockedUsd?: number }> = [];
      if (position.yesShares > 0) {
        const mark = position.lastMark;
        rows.push({
          lockedUsd: position.avgYesCost * position.yesShares,
          valueUsd: mark !== undefined ? mark * position.yesShares : undefined,
        });
      }
      if (position.noShares > 0) {
        const mark = position.lastMark !== undefined ? 1 - position.lastMark : undefined;
        rows.push({
          lockedUsd: position.avgNoCost * position.noShares,
          valueUsd: mark !== undefined ? mark * position.noShares : undefined,
        });
      }
      return rows;
    }),
    state,
    marketAppIds,
    escrowAppIds,
    forceRefresh: true,
  });

  const updatedState = mergeCapitalLedgerIntoState(state, ledger.flows, ledger.scanMeta);
  await saveAlphaState(config.stateKey, updatedState);
  printCapitalLedgerReport(ledger, walletAddress);
  try {
    const { buildAlphaDashboardSnapshot } = await import("./alphaDashboardData.js");
    await buildAlphaDashboardSnapshot();
  } catch (error) {
    console.warn(
      `[ghillie-public-pnl] publish after capital-report failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

type CancelOrderArgs = {
  marketAppId?: number;
  slug?: string;
  escrowAppId?: number;
  execute: boolean;
};

function parseCancelOrderArgs(args: string[]): CancelOrderArgs {
  const parsed: CancelOrderArgs = { execute: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--execute") {
      parsed.execute = true;
      continue;
    }
    if (arg === "--escrow" || arg === "--escrow-app-id") {
      const value = args[i + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      const num = Number.parseInt(value, 10);
      if (!Number.isFinite(num) || num <= 0) throw new Error(`Invalid escrow app id: ${value}`);
      parsed.escrowAppId = num;
      i += 1;
      continue;
    }
    if (arg === "--market" || arg === "--market-app-id") {
      const value = args[i + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      i += 1;
      const num = Number.parseInt(value, 10);
      if (Number.isFinite(num) && String(num) === value.trim()) parsed.marketAppId = num;
      else parsed.slug = value.trim();
      continue;
    }
    // Bare positional: numeric -> market app id, otherwise slug.
    const num = Number.parseInt(arg, 10);
    if (Number.isFinite(num) && String(num) === arg.trim()) parsed.marketAppId = num;
    else parsed.slug = arg.trim();
  }
  if (
    parsed.marketAppId === undefined &&
    parsed.slug === undefined &&
    parsed.escrowAppId === undefined
  ) {
    throw new Error(
      "Usage: npm run alpha:cancel-order -- <marketAppId|slug> [--escrow <escrowAppId>] [--execute]",
    );
  }
  return parsed;
}

async function runCancelOrderCommand(args: string[]): Promise<void> {
  const parsed = parseCancelOrderArgs(args);
  const config = await loadAlphaConfig();
  const walletAddress = config.walletAddress;
  if (!walletAddress || !algosdk.isValidAddress(walletAddress)) {
    throw new Error(
      "ALPHA_WALLET_ADDRESS or a mnemonic-derived address is required for cancel-order",
    );
  }
  if (parsed.execute && !config.walletMnemonic) {
    throw new Error("ALPHA_WALLET_MNEMONIC is required to --execute a cancel");
  }

  const client = new AlphaSdkClient(config, parsed.execute);

  let marketAppId = parsed.marketAppId;
  if (marketAppId === undefined && parsed.slug) {
    const market = await client.getMarket(parsed.slug);
    if (!market) throw new Error(`Alpha market not found for slug/id: ${parsed.slug}`);
    marketAppId = market.marketAppId;
  }

  const walletOrders = await client.getWalletOpenOrders(walletAddress);
  const matches = walletOrders.filter((order) => {
    if (parsed.escrowAppId !== undefined && order.escrowAppId !== parsed.escrowAppId) return false;
    if (marketAppId !== undefined && order.marketAppId !== marketAppId) return false;
    return true;
  });

  console.log("GHILLIE ALPHA CANCEL ORDER");
  console.log("");
  console.log(`Wallet: ${walletAddress}`);
  console.log(
    `Filter: marketAppId=${marketAppId ?? "any"} escrowAppId=${parsed.escrowAppId ?? "any"}`,
  );
  console.log(
    `Mode: ${parsed.execute ? "EXECUTE (live on-chain cancel)" : "dry-run (no changes)"}`,
  );
  console.log(`Matching open orders: ${matches.length}`);
  console.log("");

  if (matches.length === 0) {
    console.log("No matching open orders found; nothing to cancel.");
    return;
  }

  for (const order of matches) {
    const price = (order.price ?? 0) / 1_000_000;
    const qty = (order.quantity ?? 0) / 1_000_000;
    const filled = (order.quantityFilled ?? 0) / 1_000_000;
    const remaining = Math.max(0, qty - filled);
    const sideLabel = order.side === 1 ? "bid" : "ask";
    const outcomeLabel = order.position === 1 ? "YES" : "NO";
    console.log(
      `  marketAppId=${order.marketAppId} escrowAppId=${order.escrowAppId} ${outcomeLabel} ${sideLabel} price=${price.toFixed(
        3,
      )} remaining=${remaining.toFixed(6)} notional=$${(price * remaining).toFixed(2)}`,
    );
  }
  console.log("");

  if (!parsed.execute) {
    console.log("Dry-run only. Re-run with --execute to cancel the orders above.");
    return;
  }

  const state = await loadAlphaState(config.stateKey, config.paperStartingBalanceUsd);
  let cancelled = 0;
  for (const order of matches) {
    try {
      const result = await client.cancelOrder({
        marketAppId: order.marketAppId,
        escrowAppId: order.escrowAppId,
        orderOwner: order.owner ?? walletAddress,
      });
      if (result.success) {
        cancelled += 1;
        const now = new Date().toISOString();
        for (const tracked of state.openOrders) {
          if (tracked.liveEscrowAppId === order.escrowAppId && tracked.status === "open") {
            tracked.status = "cancelled";
            tracked.updatedAt = now;
            state.cancelledOrders.push({ ...tracked });
          }
        }
        console.log(
          `[CANCELLED] escrowAppId=${order.escrowAppId} (marketAppId=${order.marketAppId})`,
        );
      } else {
        console.log(`[FAILED] escrowAppId=${order.escrowAppId}: cancel returned success=false`);
      }
    } catch (error) {
      console.log(
        `[FAILED] escrowAppId=${order.escrowAppId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  state.openOrders = state.openOrders.filter((order) => order.status === "open");
  await saveAlphaState(config.stateKey, state);
  console.log("");
  console.log(`Cancelled ${cancelled}/${matches.length} matching order(s); bot state updated.`);
}

function logStartupDebug(message: string): void {
  if (!isDebugModeEnabled()) return;
  console.log(`[startup-debug ${new Date().toISOString()}] ${message}`);
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const lines = [error.message];
  const cause = error.cause;
  if (cause instanceof Error) {
    lines.push(`cause: ${cause.message}`);
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) lines.push(`cause_code: ${code}`);
  }
  return lines.join("\n");
}

async function recordScanX402Spend(
  config: AlphaConfig,
  payments: AlphaScanResult["payments"],
): Promise<void> {
  if (!payments?.length) return;
  await persistX402SpendCounters(config, payments);
}

async function buildScan(liveSigner = false) {
  const startedAt = Date.now();
  logStartupDebug(`buildScan start liveSigner=${liveSigner}`);
  const config = await loadAlphaConfig();
  logStartupDebug(
    `buildScan config loaded matcherAppId=${config.matcherAppId} usdcAssetId=${config.usdcAssetId} wallet=${config.walletAddress ?? "none"} amarokMcp=${config.amarokMcpUrl}`,
  );
  const client = new AlphaSdkClient(config, liveSigner);
  logStartupDebug(`buildScan venue client created liveSigner=${liveSigner}`);
  const scan = await loadAlphaScan(config);
  logStartupDebug(
    `buildScan scan loaded markets=${scan.markets.length} rewardMarkets=${scan.rewardMarkets.length} orderbooks=${scan.orderbooks.size} rewardError=${scan.rewardError ?? "none"}`,
  );
  const uniqueMarkets = new Map(
    [...scan.rewardMarkets, ...scan.markets].map((market) => [market.marketAppId, market]),
  );
  const allMarkets = [...uniqueMarkets.values()];
  logStartupDebug(`buildScan unique markets prepared count=${allMarkets.length}`);
  const rewardCandidates = rankRewardCandidates(allMarkets, scan.orderbooks, config);
  logStartupDebug(`buildScan reward candidates ranked count=${rewardCandidates.length}`);
  const parity = scanParity(allMarkets, scan.orderbooks, config);
  logStartupDebug(`buildScan parity scan complete opportunities=${parity.length}`);
  logStartupDebug(`buildScan end elapsed_ms=${Date.now() - startedAt}`);
  return { config, client, scan, rewardCandidates, parity };
}

async function runScanCommand(): Promise<void> {
  const { config, scan, rewardCandidates, parity } = await buildScan(false);
  await recordScanX402Spend(config, scan.payments);
  printScan(scan, rewardCandidates, parity, config);
}

async function runRewardsCommand(): Promise<void> {
  const { config, scan, rewardCandidates } = await buildScan(false);
  await recordScanX402Spend(config, scan.payments);
  printRewards(scan.rewardMarkets, rewardCandidates, scan.rewardError);
}

async function runMarketCommand(arg: string | undefined): Promise<void> {
  if (!arg) throw new Error("Usage: npm run alpha:market -- <slug-or-id>");
  const config = await loadAlphaConfig();
  const { market, orderbook } = await loadAmarokMarket(config, arg);
  printMarketDetail(market, orderbook);
}

async function runPaperCommand(): Promise<void> {
  const { config, scan } = await buildScan(false);
  await recordScanX402Spend(config, scan.payments);
  const state = await runPaperTick(scan, config);
  printPaperWatch(state);
}

async function runPaperWatchCommand(): Promise<void> {
  const initial = await loadAlphaConfig();
  const loop = async () => {
    try {
      const { config, scan } = await buildScan(false);
      await recordScanX402Spend(config, scan.payments);
      const state = await runPaperTick(scan, config);
      printPaperWatch(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${new Date().toISOString().slice(11, 19)}] alpha_paper_failed: ${message}`);
    }
  };
  await loop();
  setInterval(loop, initial.scanIntervalMs);
}

async function runPaperReportCommand(): Promise<void> {
  const config = await loadAlphaConfig();
  const state = await loadPaperReport(config);
  printPaperReport(state);
}

function extractTickAbortMessages(actions: LiveAction[]): string[] {
  return actions
    .filter((action) => action.message.startsWith("Tick aborted safely:"))
    .map((action) => action.message.replace("Tick aborted safely:", "").trim());
}

function readDailySummaryHourUtc(): number | undefined {
  const raw = process.env.ALPHA_TELEGRAM_DAILY_SUMMARY_HOUR?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 23) return undefined;
  return parsed;
}

function formatUsd(value: number | undefined): string {
  if (value === undefined) return "unknown";
  return `$${value.toFixed(2)}`;
}

function shouldSendDailySummary(state: AlphaBotState): boolean {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (state.notificationState?.lastDailySummaryDate === today) return false;
  const targetHour = readDailySummaryHourUtc();
  if (targetHour === undefined) return true;
  return now.getUTCHours() === targetHour;
}

async function runLiveCommand(mode: "live-dry-run" | "live"): Promise<void> {
  const startedAt = Date.now();
  logStartupDebug(`runLiveCommand start mode=${mode}`);
  const { config, scan } = await buildScan(mode === "live");
  logStartupDebug(
    `runLiveCommand buildScan done mode=${mode} markets=${scan.markets.length} rewardMarkets=${scan.rewardMarkets.length}`,
  );
  const result = await runLiveTick(scan, config, mode);
  logStartupDebug(`runLiveCommand runLiveTick done mode=${mode} actions=${result.actions.length}`);
  const abortMessages = extractTickAbortMessages(result.actions);
  if (mode === "live" && abortMessages.length > 0) {
    const throttleMinutes = readSkipNoticeThrottleMinutes();
    const summary = abortMessages.slice(0, 2).join(" | ");
    await notifyTelegramThrottled(
      "alpha-live-tick-aborted",
      `ALERT: Ghillie live tick aborted safely\nreasons=${summary}\nwallet_usdc=${formatUsd(result.walletUsdcBalanceUsd)}\nwallet_algo=${
        result.walletAlgoBalance === undefined ? "unknown" : result.walletAlgoBalance.toFixed(6)
      }`,
      { throttleMinutes },
    );
  }
  const allPayments = [...(scan.payments ?? []), ...(result.payments ?? [])];
  if (mode === "live") {
    applyX402PaymentsToState(result.state, allPayments);
  } else {
    await recordScanX402Spend(config, allPayments.length > 0 ? allPayments : undefined);
    applyX402PaymentsToState(result.state, allPayments);
  }
  const spendReport = toX402SpendReport(result.state.x402Spend, config.maxDailyX402BaseUnits);
  const reportBase = {
    state: result.state,
    walletUsdcBalanceUsd: result.walletUsdcBalanceUsd,
    walletAlgoBalance: result.walletAlgoBalance,
    config,
    rewardContext: rewardContextFromScan(scan, config.walletAddress),
    spend: {
      payments: allPayments,
      daily: spendReport.amarok,
    },
  };
  if (mode === "live") {
    const digest = formatTickDigestReport({
      ...reportBase,
      actions: result.actions,
    });
    await notifyTelegramReport(digest);
    if (shouldSendDailySummary(result.state)) {
      const dailySummary = formatDailySummaryReport(reportBase);
      const sent = await notifyTelegramReport(dailySummary);
      if (sent) {
        result.state.notificationState ??= {};
        result.state.notificationState.lastDailySummaryDate = new Date().toISOString().slice(0, 10);
      }
    }
    await saveAlphaState(config.stateKey, result.state);
  }
  console.log(mode === "live" ? "GHILLIE ALPHA LIVE" : "GHILLIE ALPHA LIVE DRY RUN");
  console.log("");
  for (const action of result.actions) {
    console.log(`[${action.kind.toUpperCase()}] ${action.message}`);
  }
  if (result.actions.length === 0) console.log("No actions.");
  printLiveSummary(
    result.state,
    result.walletUsdcBalanceUsd,
    result.walletAlgoBalance,
    config,
    rewardContextFromScan(scan, config.walletAddress),
  );
  for (const line of formatDailySpendLines(spendReport)) {
    console.log(`  ${line}`);
  }
  if (allPayments.length > 0) {
    console.log(
      `  ${formatAmarokX402ThisRunLine(allPayments.length, sumPaymentBaseUnits(allPayments))}`,
    );
  }
  if (mode === "live") {
    try {
      const { buildAlphaDashboardSnapshot } = await import("./alphaDashboardData.js");
      await buildAlphaDashboardSnapshot();
    } catch (error) {
      console.warn(
        `[ghillie-public-pnl] publish after live tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  logStartupDebug(`runLiveCommand end mode=${mode} elapsed_ms=${Date.now() - startedAt}`);
}

type ResolvedAssetCleanupArgs = {
  execute: boolean;
  limit?: number;
};

function parseResolvedAssetCleanupArgs(args: string[]): ResolvedAssetCleanupArgs {
  let execute = false;
  let limit: number | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (arg === "--limit") {
      const value = args[i + 1];
      if (!value) throw new Error("Missing value for --limit");
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0)
        throw new Error(`Invalid --limit value: ${value}`);
      limit = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const value = arg.slice("--limit=".length);
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0)
        throw new Error(`Invalid --limit value: ${value}`);
      limit = parsed;
      continue;
    }
    throw new Error(`Unknown argument for resolved-asset-cleanup: ${arg}`);
  }
  return { execute, limit };
}

async function runResolvedAssetCleanupCommand(args: string[]): Promise<void> {
  const parsed = parseResolvedAssetCleanupArgs(args);
  await runResolvedAssetCleanup(parsed);
}

function printUsage(): void {
  console.log(
    "Usage: tsx src/alpha/alphaCommands.ts <scan|rewards|reward-history|capital-report|watch|market|paper|paper-watch|paper-report|live-dry-run|live|resolved-asset-cleanup|cancel-order>",
  );
  console.log("  reward-history args: [receiverAddress] [rewardSenderAddress]");
  console.log("  resolved-asset-cleanup args: [--execute] [--limit N]");
  console.log("  cancel-order args: <marketAppId|slug> [--escrow <escrowAppId>] [--execute]");
}

async function main(): Promise<void> {
  const command = process.argv[2];
  logStartupDebug(
    `main start command=${command ?? "none"} pid=${process.pid} cwd=${process.cwd()} node=${process.version} args=${process.argv.slice(2).join(" ")}`,
  );
  if (command === "scan") return runScanCommand();
  if (command === "rewards") return runRewardsCommand();
  if (command === "reward-history")
    return runRewardHistoryCommand(process.argv[3], process.argv[4]);
  if (command === "capital-report") return runCapitalReportCommand();
  if (command === "watch") return runPaperWatchCommand();
  if (command === "market") return runMarketCommand(process.argv[3]);
  if (command === "paper") return runPaperCommand();
  if (command === "paper-watch") return runPaperWatchCommand();
  if (command === "paper-report") return runPaperReportCommand();
  if (command === "live-dry-run") return runLiveCommand("live-dry-run");
  if (command === "live") return runLiveCommand("live");
  if (command === "resolved-asset-cleanup")
    return runResolvedAssetCleanupCommand(process.argv.slice(3));
  if (command === "cancel-order") return runCancelOrderCommand(process.argv.slice(3));
  printUsage();
  process.exitCode = 1;
}

void main()
  .catch((error) => {
    const message = formatError(error);
    logStartupDebug(`main failed message=${message}`);
    console.error(message);
    process.exitCode = 1;
  })
  .finally(() => {
    logStartupDebug(
      `main finally command=${process.argv[2] ?? "none"} exitCode=${process.exitCode ?? 0}`,
    );
  });
