import { buildAccountancySnapshot, formatAccountancyDigestLines } from "./accountancyLedgers.js";
import type { AlphaConfig } from "./alphaConfig.js";
import { type AlphaScanResult, summarizeBooks } from "./alphaMarketScanner.js";
import type {
  AlphaBotState,
  AlphaMarket,
  AlphaOpportunity,
  AlphaOrderbook,
  AlphaParityPlan,
} from "./alphaTypes.js";
import {
  estimateRewardRateForOrders,
  type RewardRateContext,
  reliableDailyRewardUsd,
} from "./rewardRateEstimator.js";

export function fmtUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  const sign = value > 0 ? "+" : "";
  return `${sign}$${value.toFixed(2)}`;
}

export function fmtRewardUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  const sign = value > 0 ? "+" : "";
  const decimals = Math.abs(value) < 0.01 ? 6 : 2;
  return `${sign}$${value.toFixed(decimals)}`;
}

function fmtPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  return `${(value * 100).toFixed(2)}%`;
}

export function fmtPrice(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "-" : value.toFixed(3);
}

export function fmtCents(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value)
    ? "unknown"
    : `${(value * 100).toFixed(2)}c`;
}

function spreadRows(scan: AlphaScanResult): Array<{
  marketAppId: number;
  title: string;
  outcome: "YES" | "NO";
  bid: number;
  ask: number;
  spread: number;
  midpoint: number;
}> {
  const marketByAppId = new Map(
    [...scan.markets, ...scan.rewardMarkets].map((market) => [market.marketAppId, market]),
  );
  const rows: Array<{
    marketAppId: number;
    title: string;
    outcome: "YES" | "NO";
    bid: number;
    ask: number;
    spread: number;
    midpoint: number;
  }> = [];
  for (const book of scan.orderbooks.values()) {
    const market = marketByAppId.get(book.marketAppId);
    if (!market) continue;
    if (
      book.yesBid !== undefined &&
      book.yesAsk !== undefined &&
      book.yesMid !== undefined &&
      book.yesSpread !== undefined
    ) {
      rows.push({
        marketAppId: market.marketAppId,
        title: market.title,
        outcome: "YES",
        bid: book.yesBid,
        ask: book.yesAsk,
        spread: book.yesSpread,
        midpoint: book.yesMid,
      });
    }
    if (
      book.noBid !== undefined &&
      book.noAsk !== undefined &&
      book.noMid !== undefined &&
      book.noSpread !== undefined
    ) {
      rows.push({
        marketAppId: market.marketAppId,
        title: market.title,
        outcome: "NO",
        bid: book.noBid,
        ask: book.noAsk,
        spread: book.noSpread,
        midpoint: book.noMid,
      });
    }
  }
  return rows.sort((a, b) => b.spread - a.spread);
}

function fmtVolume(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function uniqueMarketsByVolume(scan: AlphaScanResult): AlphaMarket[] {
  const markets = new Map<number, AlphaMarket>();
  for (const market of [...scan.markets, ...scan.rewardMarkets]) {
    const previous = markets.get(market.marketAppId);
    markets.set(market.marketAppId, {
      ...market,
      reward: market.reward.isRewardMarket ? market.reward : (previous?.reward ?? market.reward),
      volume: market.volume ?? previous?.volume,
    });
  }
  return [...markets.values()].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
}

function bestDepthUsd(levels: Array<{ price: number; quantityShares: number }>): number {
  const [level] = levels;
  return level ? level.price * level.quantityShares : 0;
}

function outcomeDepthUsd(book: AlphaOrderbook, outcome: "YES" | "NO"): number {
  const orders = outcome === "YES" ? book.yesSideOrders : book.noSideOrders;
  return Math.min(bestDepthUsd(orders.bids), bestDepthUsd(orders.asks));
}

function bestSpreadMatch(
  market: AlphaMarket,
  book: AlphaOrderbook | undefined,
  config: AlphaConfig,
): { label: string; reason: string } {
  if (!config.enableSpreadCapture) return { label: "off", reason: "disabled" };
  if (!book || book.source === "unavailable")
    return { label: "no", reason: "book unavailable/not scanned" };
  if ((market.volume ?? 0) < config.minSpreadVolumeUsd)
    return { label: "no", reason: `volume < $${config.minSpreadVolumeUsd.toFixed(2)}` };
  const candidates = [
    {
      outcome: "YES",
      bid: book.yesBid,
      ask: book.yesAsk,
      mid: book.yesMid,
      spread: book.yesSpread,
      depthUsd: outcomeDepthUsd(book, "YES"),
    },
    {
      outcome: "NO",
      bid: book.noBid,
      ask: book.noAsk,
      mid: book.noMid,
      spread: book.noSpread,
      depthUsd: outcomeDepthUsd(book, "NO"),
    },
  ] as const;
  const matches = candidates
    .filter(
      (candidate) =>
        candidate.bid !== undefined &&
        candidate.ask !== undefined &&
        candidate.mid !== undefined &&
        candidate.spread !== undefined &&
        candidate.spread * 100 >= config.minSpreadCaptureCents &&
        candidate.depthUsd >= config.minSpreadDepthUsd &&
        candidate.mid >= config.minSpreadEntryMidpoint &&
        candidate.mid <= config.maxSpreadMidpoint,
    )
    .sort((a, b) => (b.spread ?? 0) - (a.spread ?? 0));
  const best = matches[0];
  if (best)
    return {
      label: "watch",
      reason: `${best.outcome} ${fmtCents(best.spread)} @ mid ${fmtPrice(best.mid)}, depth $${best.depthUsd.toFixed(2)}; needs ${config.spreadPersistenceScans} live scans`,
    };
  const twoSided = candidates.find(
    (candidate) =>
      candidate.bid !== undefined && candidate.ask !== undefined && candidate.mid !== undefined,
  );
  if (!twoSided) return { label: "no", reason: "no two-sided outcome" };
  if ((twoSided.spread ?? 0) * 100 < config.minSpreadCaptureCents)
    return { label: "no", reason: `spread < ${config.minSpreadCaptureCents.toFixed(2)}c` };
  if (twoSided.depthUsd < config.minSpreadDepthUsd)
    return { label: "no", reason: `depth < $${config.minSpreadDepthUsd.toFixed(2)}` };
  return {
    label: "no",
    reason: `mid outside ${fmtPrice(config.minSpreadEntryMidpoint)}-${fmtPrice(config.maxSpreadMidpoint)}`,
  };
}

function rewardMatch(
  market: AlphaMarket,
  rewardByMarketAppId: Map<number, AlphaOpportunity>,
): { label: string; reason: string } {
  if (!market.reward.isRewardMarket) return { label: "no", reason: "not reward market" };
  const candidate = rewardByMarketAppId.get(market.marketAppId);
  if (!candidate) return { label: "watch", reason: "reward metadata incomplete" };
  if (candidate.warnings.length === 0)
    return { label: "good", reason: `daily ${fmtUsd(candidate.reward.estimatedRewardUsdPerDay)}` };
  return { label: "watch", reason: candidate.warnings.join("; ") };
}

export function printScan(
  scan: AlphaScanResult,
  rewardCandidates: AlphaOpportunity[],
  parity: AlphaParityPlan[],
  config: AlphaConfig,
): void {
  const surface = summarizeBooks(scan.orderbooks.values());
  const rewardByMarketAppId = new Map(
    rewardCandidates.map((candidate) => [candidate.marketAppId, candidate]),
  );
  const marketRows = uniqueMarketsByVolume(scan);
  console.log("GHILLIE / ALPHA ARCADE");
  console.log("");
  console.log(`Markets loaded: ${scan.markets.length}`);
  console.log(`Reward markets loaded: ${scan.rewardMarkets.length}`);
  if (scan.rewardError) console.log(`Reward metadata warning: ${scan.rewardError}`);
  console.log(`Orderbooks scanned: ${scan.orderbooks.size}`);
  console.log("");
  console.log("Market surface:");
  console.log(`- two-sided books: ${surface.twoSided}`);
  console.log(`- one-sided books: ${surface.oneSided}`);
  console.log(`- empty books: ${surface.empty}`);
  console.log(`- avg spread: ${fmtCents(surface.averageSpread)}`);
  console.log("");
  console.log("Top LP reward candidates:");
  for (const candidate of rewardCandidates.slice(0, 8)) {
    console.log(
      `- marketAppId=${candidate.marketAppId} ${candidate.title} daily=${fmtUsd(candidate.reward.estimatedRewardUsdPerDay)} zone=${
        candidate.reward.rewardZoneDistanceCents?.toFixed(2) ?? "unknown"
      }c competition=${candidate.reward.competitionLevel ?? "unknown"}`,
    );
  }
  if (rewardCandidates.length === 0) console.log("- none");
  console.log("");
  console.log("Top spread candidates:");
  for (const row of spreadRows(scan).slice(0, 8)) {
    console.log(
      `- marketAppId=${row.marketAppId} ${row.title} ${row.outcome} bid=${fmtPrice(row.bid)} ask=${fmtPrice(row.ask)} mid=${fmtPrice(
        row.midpoint,
      )} spread=${fmtCents(row.spread)}`,
    );
  }
  if (spreadRows(scan).length === 0) console.log("- none");
  console.log("");
  console.log("Top parity / merge candidates:");
  for (const plan of parity.slice(0, 8)) {
    console.log(
      `- marketAppId=${plan.marketAppId} ${plan.title} ${plan.type} YES=${fmtPrice(plan.yesPrice)} NO=${fmtPrice(plan.noPrice)} size=${plan.sizeShares.toFixed(
        6,
      )} gross=${fmtUsd(plan.expectedGrossPnlUsd)} netEdge=${plan.estimatedNetEdgeBps.toFixed(0)}bps`,
    );
  }
  if (parity.length === 0) console.log("- none");
  console.log("");
  console.log("Markets by volume:");
  for (const market of marketRows) {
    const reward = rewardMatch(market, rewardByMarketAppId);
    const spread = bestSpreadMatch(market, scan.orderbooks.get(market.marketAppId), config);
    console.log(
      `- marketAppId=${market.marketAppId} ${market.title} volume=${fmtVolume(market.volume)} rewards=${reward.label} (${reward.reason}) spread=${spread.label} (${spread.reason})`,
    );
  }
  if (marketRows.length === 0) console.log("- none");
  console.log("");
  console.log(`Parity / split-merge candidates: ${parity.length}`);
}

export function printRewards(
  rewardMarkets: AlphaMarket[],
  candidates: AlphaOpportunity[],
  rewardError?: string,
): void {
  console.log("GHILLIE / ALPHA REWARDS");
  console.log("");
  if (rewardError) console.log(`Reward metadata warning: ${rewardError}`);
  console.log(`Reward markets loaded: ${rewardMarkets.length}`);
  const sourceCounts = new Map<string, number>();
  for (const market of rewardMarkets) {
    const source = market.reward.dailyRewardsSource ?? "unknown";
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }
  if (sourceCounts.size > 0) {
    const breakdown = [...sourceCounts.entries()]
      .map(([source, count]) => `${source}=${count}`)
      .join(", ");
    console.log(`Daily-reward source breakdown: ${breakdown}`);
  }
  console.log(
    `Showing top ${Math.min(candidates.length, 12)} of ${candidates.length} ranked reward candidate(s).`,
  );
  console.log("");
  for (const candidate of candidates.slice(0, 12)) {
    console.log("[LP REWARD CANDIDATE]");
    console.log(`Market: ${candidate.title}`);
    if (candidate.slug) console.log(`Slug: ${candidate.slug}`);
    console.log(`Daily rewards: ${fmtUsd(candidate.reward.estimatedRewardUsdPerDay)}`);
    console.log(`Competition: ${candidate.reward.competitionLevel ?? "unknown"}`);
    console.log(
      `Max reward spread: ${candidate.reward.rewardZoneDistanceCents?.toFixed(2) ?? "unknown"}c`,
    );
    const minContracts = rewardMarkets.find(
      (market) => market.marketAppId === candidate.marketAppId,
    )?.reward.minContracts;
    console.log(`Min aggregate reward size: ${minContracts?.toFixed(6) ?? "unknown"} contracts`);
    console.log(`Reason: ${candidate.reason}`);
    if (candidate.warnings.length > 0) console.log(`Warnings: ${candidate.warnings.join("; ")}`);
    console.log("");
  }
}

export function printMarketDetail(market: AlphaMarket, book: AlphaOrderbook | undefined): void {
  console.log("ALPHA MARKET DETAIL");
  console.log("");
  console.log(`Title: ${market.title}`);
  console.log(`Market app ID: ${market.marketAppId}`);
  if (market.slug) console.log(`Slug: ${market.slug}`);
  console.log(`Status: ${market.status}`);
  console.log(`Close: ${market.closeTime ?? "unknown"}`);
  console.log("");
  console.log(`LP rewards: ${market.reward.isRewardMarket ? "yes" : "no"}`);
  console.log(
    `Daily rewards: ${fmtUsd(market.reward.dailyRewardsUsd)} (source: ${market.reward.dailyRewardsSource ?? "unknown"})`,
  );
  console.log(`Max reward spread: ${market.reward.maxRewardSpreadCents?.toFixed(2) ?? "unknown"}c`);
  console.log(
    `Min aggregate reward size: ${market.reward.minContracts?.toFixed(6) ?? "unknown"} contracts`,
  );
  console.log(`Competition: ${market.reward.competitionLevel ?? "unknown"}`);
  console.log("");
  if (!book) {
    console.log("Orderbook unavailable");
    return;
  }
  console.log(`Orderbook source: ${book.source}`);
  console.log(`YES bid/ask: ${fmtPrice(book.yesBid)} / ${fmtPrice(book.yesAsk)}`);
  console.log(`NO bid/ask: ${fmtPrice(book.noBid)} / ${fmtPrice(book.noAsk)}`);
  console.log(`Best spread: ${fmtCents(book.bestSpread)}`);
}

export function printPaperWatch(state: AlphaBotState): void {
  const open = state.openOrders.filter((order) => order.status === "open");
  const rewardEligible = open.filter((order) => order.rewardEligible).length;
  console.log(
    `[${new Date().toISOString().slice(11, 19)}] openOrders=${open.length} rewardEligible=${rewardEligible} fills=${
      state.fills.length
    } cash=$${state.cash.toFixed(2)} tradingPnl=${fmtUsd(state.totalPnl)} estRewards=${fmtUsd(state.estimatedRewardsUsd)}`,
  );
}

export function summarizeLiveExposure(
  state: AlphaBotState,
  config?: Pick<AlphaConfig, "rewardMinDwellSeconds" | "walletAddress" | "rewardRateCalibration">,
  rewardContext: RewardRateContext = {},
): {
  openOrders: number;
  bidOrders: number;
  exitOrders: number;
  openPositions: number;
  underwaterPositions: number;
  bidExposureUsd: number;
  rewardBidOrders: number;
  rewardBidExposureUsd: number;
  rewardEligibleBidOrders: number;
  rewardEligibleBidExposureUsd: number;
  spreadBidOrders: number;
  spreadBidExposureUsd: number;
  exitNotionalUsd: number;
  controlledExitNotionalUsd: number;
  exitPnlIfFilledUsd: number;
  realisedPlusOpenExitPnlUsd: number;
  underwaterInventoryNotionalUsd: number;
  underwaterInventoryUnrealisedLossUsd: number;
  rewardEligibleExitOrders: number;
  rewardEligibleExitNotionalUsd: number;
  rewardEligibleOrders: number;
  rewardEligibleLiquidityUsd: number;
  activeRewardBidOrders: number;
  activeRewardOrders: number;
  activeRewardLiquidityShare?: number;
  potentialRewardLiquidityShare?: number;
  activeRewardRateDailyUsd?: number;
  activeRewardRateHourlyUsd?: number;
  potentialRewardRateDailyUsd?: number;
  potentialRewardRateHourlyUsd?: number;
  actualRewardsReceivedUsd?: number;
  actualRewardsAsOf?: string;
} {
  // Reward income/eligibility reporting is restricted to markets with a genuine
  // daily emission. Pool-fallback markets pay ~$0 on-chain, so an order resting
  // in one is not counted as reward-eligible liquidity (avoids fabricated income
  // in the digest). When no market context is supplied we cannot verify, so we
  // do not gate (preserves non-live report behaviour).
  const rewardMarketByAppId = new Map<number, AlphaMarket>();
  if (rewardContext.markets) {
    const iterable =
      rewardContext.markets instanceof Map ? rewardContext.markets.values() : rewardContext.markets;
    for (const market of iterable) rewardMarketByAppId.set(market.marketAppId, market);
  }
  const haveMarketContext = rewardMarketByAppId.size > 0;
  const isReliableRewardMarket = (marketAppId: number): boolean =>
    !haveMarketContext ||
    reliableDailyRewardUsd(rewardMarketByAppId.get(marketAppId)) !== undefined;
  const isReportableRewardOrder = (order: {
    rewardEligible: boolean;
    marketAppId: number;
  }): boolean => order.rewardEligible && isReliableRewardMarket(order.marketAppId);

  const open = state.openOrders.filter(
    (order) => order.status === "open" && order.runMode === "live",
  );
  const bids = open.filter((order) => order.side === "bid");
  const rewardBids = bids.filter((order) => order.source === "reward");
  const rewardEligibleBids = bids.filter((order) => isReportableRewardOrder(order));
  const rewardEligibleOrders = open.filter((order) => isReportableRewardOrder(order));
  const spreadBids = bids.filter((order) => order.source === "spread");
  const exits = open.filter((order) => order.side === "ask" || order.source === "inventory_exit");
  const controlledExits = exits.filter((order) =>
    order.reason.startsWith("controlled underwater exit"),
  );
  const rewardEligibleExits = exits.filter((order) => isReportableRewardOrder(order));
  const bidExposure = (orders: typeof bids) =>
    orders.reduce((sum, order) => sum + order.price * order.remainingShares, 0);
  const exitNotional = (orders: typeof exits) =>
    orders.reduce((sum, order) => sum + order.price * order.remainingShares, 0);
  const exitPnlIfFilledUsd = exits.reduce((sum, order) => {
    const position =
      state.positionsByMarket[String(order.marketAppId)] ?? state.positionsByMarket[order.marketId];
    const averageCost = order.outcome === "YES" ? position?.avgYesCost : position?.avgNoCost;
    return sum + (order.price - (averageCost ?? 0)) * order.remainingShares;
  }, 0);
  const minDwellSeconds = config?.rewardMinDwellSeconds ?? 0;
  const now = Date.now();
  const marketEligibility = new Map<number, { restingContracts: number; minContracts: number }>();
  for (const order of rewardEligibleOrders) {
    const current = marketEligibility.get(order.marketAppId) ?? {
      restingContracts: 0,
      minContracts: order.rewardMinContracts ?? 0,
    };
    current.restingContracts += order.remainingShares;
    current.minContracts = Math.max(current.minContracts, order.rewardMinContracts ?? 0);
    marketEligibility.set(order.marketAppId, current);
  }
  const activeRewardOrders = rewardEligibleOrders.filter((order) => {
    const created = Date.parse(order.createdAt);
    const ageSeconds = Number.isFinite(created) ? Math.max(0, (now - created) / 1000) : 0;
    const eligibility = marketEligibility.get(order.marketAppId);
    return (
      ageSeconds >= minDwellSeconds &&
      (eligibility?.restingContracts ?? 0) >= (eligibility?.minContracts ?? 0)
    );
  });
  const activeRewardBids = activeRewardOrders.filter((order) => order.side === "bid");
  const rewardRateContext = {
    ...rewardContext,
    walletAddress: rewardContext.walletAddress ?? config?.walletAddress,
    calibration: config?.rewardRateCalibration ?? rewardContext.calibration,
  };
  const activeRewardRate = estimateRewardRateForOrders(activeRewardOrders, rewardRateContext);
  const potentialRewardRate = estimateRewardRateForOrders(rewardEligibleOrders, rewardRateContext);
  const heldPositions = Object.values(state.positionsByMarket).filter(
    (position) => position.yesShares > 1e-6 || position.noShares > 1e-6,
  );
  const underwaterPositions = heldPositions.filter((position) => position.unrealisedPnl < 0);

  return {
    openOrders: open.length,
    bidOrders: bids.length,
    exitOrders: exits.length,
    openPositions: heldPositions.length,
    underwaterPositions: underwaterPositions.length,
    bidExposureUsd: bidExposure(bids),
    rewardBidOrders: rewardBids.length,
    rewardBidExposureUsd: bidExposure(rewardBids),
    rewardEligibleBidOrders: rewardEligibleBids.length,
    rewardEligibleBidExposureUsd: bidExposure(rewardEligibleBids),
    spreadBidOrders: spreadBids.length,
    spreadBidExposureUsd: bidExposure(spreadBids),
    exitNotionalUsd: exitNotional(exits),
    controlledExitNotionalUsd: exitNotional(controlledExits),
    exitPnlIfFilledUsd,
    realisedPlusOpenExitPnlUsd: state.realisedPnl + exitPnlIfFilledUsd,
    underwaterInventoryNotionalUsd: underwaterPositions.reduce(
      (sum, position) =>
        sum + position.yesShares * position.avgYesCost + position.noShares * position.avgNoCost,
      0,
    ),
    underwaterInventoryUnrealisedLossUsd: underwaterPositions.reduce(
      (sum, position) => sum + Math.abs(position.unrealisedPnl),
      0,
    ),
    rewardEligibleExitOrders: rewardEligibleExits.length,
    rewardEligibleExitNotionalUsd: exitNotional(rewardEligibleExits),
    rewardEligibleOrders: rewardEligibleOrders.length,
    rewardEligibleLiquidityUsd: rewardEligibleOrders.reduce(
      (sum, order) => sum + order.price * order.remainingShares,
      0,
    ),
    activeRewardBidOrders: activeRewardBids.length,
    activeRewardOrders: activeRewardOrders.length,
    activeRewardLiquidityShare: activeRewardRate.liquidityShare,
    potentialRewardLiquidityShare: potentialRewardRate.liquidityShare,
    activeRewardRateDailyUsd: activeRewardRate.dailyUsd,
    activeRewardRateHourlyUsd: activeRewardRate.hourlyUsd,
    potentialRewardRateDailyUsd: potentialRewardRate.dailyUsd,
    potentialRewardRateHourlyUsd: potentialRewardRate.hourlyUsd,
    actualRewardsReceivedUsd: state.capitalLedger?.rewardsReceivedUsd,
    actualRewardsAsOf: state.capitalLedger?.lastScanAt,
  };
}

export function printLiveSummary(
  state: AlphaBotState,
  walletUsdcBalanceUsd?: number,
  walletAlgoBalance?: number,
  config?: AlphaConfig,
  rewardContext: RewardRateContext = {},
): void {
  const exposure = summarizeLiveExposure(state, config, rewardContext);
  const positionsValueUsd = Object.values(state.positionsByMarket).reduce((sum, position) => {
    const yesMark = position.lastMark ?? position.avgYesCost;
    const noMark = position.lastMark ?? position.avgNoCost;
    return sum + position.yesShares * yesMark + position.noShares * noMark;
  }, 0);
  const accountancyLines = formatAccountancyDigestLines(
    buildAccountancySnapshot({
      state,
      walletUsdc: walletUsdcBalanceUsd,
      bidEscrowUsd: exposure.bidExposureUsd,
      positionsValueUsd,
    }),
    fmtUsd,
    fmtRewardUsd,
  );
  const walletAlgo = walletAlgoBalance === undefined ? "unknown" : walletAlgoBalance.toFixed(6);
  console.log("");
  console.log(`[${new Date().toISOString().slice(11, 19)}] liveSummary`);
  console.log(`  wallet: ${fmtUsd(walletUsdcBalanceUsd)} USDC | ${walletAlgo} ALGO`);
  console.log(
    `  orders: ${exposure.openOrders} open (${exposure.bidOrders} bid, ${exposure.exitOrders} exit) | positions: ${exposure.openPositions} (${exposure.underwaterPositions} underwater)`,
  );
  console.log(
    `  bidExposure: ${fmtUsd(exposure.bidExposureUsd)} (reward ${fmtUsd(exposure.rewardBidExposureUsd)}, eligible ${fmtUsd(
      exposure.rewardEligibleBidExposureUsd,
    )}, spread ${fmtUsd(exposure.spreadBidExposureUsd)})`,
  );
  console.log(
    `  exitNotional: ${fmtUsd(exposure.exitNotionalUsd)} (controlled ${fmtUsd(exposure.controlledExitNotionalUsd)}, eligible ${fmtUsd(
      exposure.rewardEligibleExitNotionalUsd,
    )}; not counted as exposure)`,
  );
  console.log(
    `  underwaterInventory: notional ${fmtUsd(exposure.underwaterInventoryNotionalUsd)} | unrealisedLoss ${fmtUsd(
      exposure.underwaterInventoryUnrealisedLossUsd,
    )}`,
  );
  for (const line of accountancyLines) {
    console.log(`  ${line}`);
  }
  console.log(
    `  exitIfFilled ${fmtUsd(exposure.exitPnlIfFilledUsd)} | realised+openExit ${fmtUsd(exposure.realisedPlusOpenExitPnlUsd)}`,
  );
  console.log(
    `  reward_rates: eligibleLiquidity ${fmtUsd(exposure.rewardEligibleLiquidityUsd)} (${exposure.rewardEligibleOrders} ord) | active ${fmtRewardUsd(
      exposure.activeRewardRateDailyUsd,
    )}/day (${exposure.activeRewardOrders} ord) | potential ${fmtRewardUsd(
      exposure.potentialRewardRateDailyUsd,
    )}/day | share ${fmtPercent(exposure.activeRewardLiquidityShare)}/${fmtPercent(exposure.potentialRewardLiquidityShare)}`,
  );
  console.log(
    `  spread: pnl ${fmtUsd(state.strategyStats.spreadRealisedPnl)} fills ${state.strategyStats.spreadEntryFills}/${
      state.strategyStats.spreadExitFills
    } | parity: pnl ${fmtUsd(state.strategyStats.parityGrossPnl)} trades ${state.strategyStats.parityTradesExecuted} failed ${
      state.strategyStats.parityFailedLegs
    }`,
  );
  console.log(
    `  lifetime: placed ${state.strategyStats.liveOrdersPlaced} | cancelled ${state.strategyStats.liveOrdersCancelled}`,
  );
}

export function printPaperReport(state: AlphaBotState): void {
  console.log("GHILLIE ALPHA PAPER REPORT");
  console.log("");
  console.log(`Starting balance: $${state.startingBalance.toFixed(2)}`);
  console.log(`Cash: $${state.cash.toFixed(2)}`);
  console.log(`Realised P&L: ${fmtUsd(state.realisedPnl)}`);
  console.log(`Unrealised P&L: ${fmtUsd(state.unrealisedPnl)}`);
  console.log(`Estimated LP rewards: ${fmtUsd(state.estimatedRewardsUsd)}`);
  console.log(`Total trading P&L: ${fmtUsd(state.totalPnl)}`);
  console.log(`Total estimated result: ${fmtUsd(state.totalPnl + state.estimatedRewardsUsd)}`);
  console.log("");
  console.log(`Open orders: ${state.openOrders.filter((order) => order.status === "open").length}`);
  console.log(`Fills: ${state.fills.length}`);
  console.log(`Cancelled/expired orders: ${state.cancelledOrders.length}`);
  console.log(`Reward-eligible time: ${(state.rewardEligibleSeconds / 3600).toFixed(2)}h`);
}
