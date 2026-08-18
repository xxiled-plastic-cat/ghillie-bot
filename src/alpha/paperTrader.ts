import type { AlphaConfig } from "./alphaConfig.js";
import type { AlphaScanResult } from "./alphaMarketScanner.js";
import { checkQuoteRisk } from "./alphaRiskManager.js";
import { loadAlphaState, saveAlphaState } from "./alphaStateStore.js";
import type { AlphaBotState, AlphaMarket, AlphaPaperOrder, AlphaQuote } from "./alphaTypes.js";
import { cancelStalePaperOrders, detectPaperFills } from "./fillTracker.js";
import { updateUnrealisedPnl } from "./pnlTracker.js";
import { generateQuotes } from "./quoteEngine.js";
import { accrueEstimatedRewards } from "./rewardTracker.js";

function toPaperOrder(quote: AlphaQuote): AlphaPaperOrder {
  const now = new Date().toISOString();
  return {
    ...quote,
    runMode: "paper",
    createdAt: now,
    updatedAt: now,
    status: "open",
    reservedUsd: quote.side === "bid" ? quote.notionalUsd : 0,
    filledShares: 0,
    remainingShares: quote.sizeShares,
  };
}

function placePaperOrder(state: AlphaBotState, quote: AlphaQuote): void {
  const order = toPaperOrder(quote);
  if (order.side === "bid") {
    state.cash -= order.reservedUsd;
  }
  state.openOrders.push(order);
  state.strategyStats.quotesPlaced += 1;
}

export async function runPaperTick(
  scan: AlphaScanResult,
  config: AlphaConfig,
): Promise<AlphaBotState> {
  const state = await loadAlphaState(config.stateKey, config.paperStartingBalanceUsd);
  accrueEstimatedRewards(state, config, Date.now(), {
    markets: [...scan.rewardMarkets, ...scan.markets],
    orderbooks: scan.orderbooks,
    walletAddress: config.walletAddress,
  });
  detectPaperFills(state, scan.orderbooks);
  cancelStalePaperOrders(state);
  updateUnrealisedPnl(state, scan.orderbooks);

  const marketByAppId = new Map<number, AlphaMarket>();
  for (const market of [...scan.markets, ...scan.rewardMarkets]) {
    marketByAppId.set(market.marketAppId, market);
  }
  for (const market of marketByAppId.values()) {
    const book = scan.orderbooks.get(market.marketAppId);
    if (!book) continue;
    for (const quote of generateQuotes(market, book, state, config)) {
      const risk = checkQuoteRisk(quote, state, config, "paper");
      if (risk.allowed) placePaperOrder(state, quote);
    }
  }
  state.strategyStats.ticks += 1;
  state.strategyStats.rewardMarketsSeen = scan.rewardMarkets.length;
  state.strategyStats.candidatesSeen = marketByAppId.size;
  state.strategyStats.lastRunMode = "paper";
  await saveAlphaState(config.stateKey, state);
  return state;
}

export async function loadPaperReport(config: AlphaConfig): Promise<AlphaBotState> {
  return loadAlphaState(config.stateKey, config.paperStartingBalanceUsd);
}
