import type { PolyConfig } from "./polyConfig.js";
import type { PolyPaperReport, PolyPaperState, PolyPaperTickResult } from "./polyPaperTypes.js";
import type {
  PolyMarket,
  PolyOpportunity,
  PolyParityPlan,
  PolyScanResult,
  PolyTokenBookPair,
} from "./polyTypes.js";

function fmtUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  return `$${value.toFixed(2)}`;
}

function fmtCents(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  return `${value.toFixed(2)}c`;
}

function fmtPrice(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return value.toFixed(3);
}

function pairBestSpreadCents(pair: PolyTokenBookPair): number | undefined {
  const spreads = [pair.yesBook?.spread, pair.noBook?.spread].filter(
    (value): value is number => value !== undefined,
  );
  if (spreads.length === 0) return undefined;
  return Math.max(...spreads) * 100;
}

function summarizeSurface(scan: PolyScanResult): {
  twoSided: number;
  oneSided: number;
  empty: number;
  averageSpreadCents?: number;
} {
  let twoSided = 0;
  let oneSided = 0;
  let empty = 0;
  let spreadSum = 0;
  let spreadCount = 0;
  for (const pair of scan.tokenBooksByConditionId.values()) {
    const hasBid = Boolean(
      pair.yesBook?.bestBid !== undefined || pair.noBook?.bestBid !== undefined,
    );
    const hasAsk = Boolean(
      pair.yesBook?.bestAsk !== undefined || pair.noBook?.bestAsk !== undefined,
    );
    if (hasBid && hasAsk) twoSided += 1;
    else if (hasBid || hasAsk) oneSided += 1;
    else empty += 1;
    const spreadCents = pairBestSpreadCents(pair);
    if (spreadCents !== undefined) {
      spreadSum += spreadCents;
      spreadCount += 1;
    }
  }
  return {
    twoSided,
    oneSided,
    empty,
    averageSpreadCents: spreadCount > 0 ? spreadSum / spreadCount : undefined,
  };
}

export function printPolyScan(
  scan: PolyScanResult,
  rewardCandidates: PolyOpportunity[],
  spreadCandidates: PolyOpportunity[],
  parityPlans: PolyParityPlan[],
  _config: PolyConfig,
): void {
  const surface = summarizeSurface(scan);
  const marketsByVolume = [...scan.markets].sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
  console.log("GHILLIE / POLYMARKET");
  console.log("");
  console.log(`Markets loaded: ${scan.markets.length}`);
  console.log(`Reward markets loaded: ${scan.rewardMarkets.length}`);
  console.log(`Orderbooks loaded: ${scan.orderbooksByTokenId.size}`);
  console.log("");
  console.log("Market surface:");
  console.log(`- two-sided books: ${surface.twoSided}`);
  console.log(`- one-sided books: ${surface.oneSided}`);
  console.log(`- empty books: ${surface.empty}`);
  console.log(`- avg spread: ${fmtCents(surface.averageSpreadCents)}`);
  console.log("");
  console.log("Top LP reward candidates:");
  for (const candidate of rewardCandidates.slice(0, 8)) {
    console.log(
      `- ${candidate.title} daily=${fmtUsd(candidate.reward.estimatedRewardUsdPerDay)} spread=${fmtCents(
        candidate.reward.rewardZoneDistanceCents,
      )} (${candidate.classification.toLowerCase()})`,
    );
  }
  if (rewardCandidates.length === 0) console.log("- none");
  console.log("");
  console.log("Top spread candidates:");
  for (const candidate of spreadCandidates.slice(0, 8)) {
    console.log(
      `- ${candidate.title} bestSpread=${fmtCents(candidate.spread?.bestSpreadCents)} depth=${fmtUsd(
        candidate.spread?.bestDepthUsd,
      )} (${candidate.classification.toLowerCase()})`,
    );
  }
  if (spreadCandidates.length === 0) console.log("- none");
  console.log("");
  console.log("Top parity / split candidates:");
  for (const plan of parityPlans.slice(0, 8)) {
    console.log(
      `- ${plan.title} ${plan.type} YES=${fmtPrice(plan.yesPrice)} NO=${fmtPrice(plan.noPrice)} size=${plan.sizeShares.toFixed(
        4,
      )} netEdge=${plan.estimatedNetEdgeBps.toFixed(0)}bps gross=${fmtUsd(plan.expectedGrossPnlUsd)}`,
    );
  }
  if (parityPlans.length === 0) console.log("- none");
  console.log("");
  console.log("Markets by volume:");
  for (const market of marketsByVolume.slice(0, 20)) {
    console.log(
      `- ${market.title} volume24h=${fmtUsd(market.volume24h)} reward=${market.reward.isRewardMarket ? "yes" : "no"} spread=${fmtCents(
        market.spread !== undefined ? market.spread * 100 : undefined,
      )}`,
    );
  }
}

export function printPolyRewards(rewardCandidates: PolyOpportunity[]): void {
  console.log("GHILLIE / POLYMARKET REWARDS");
  console.log("");
  for (const candidate of rewardCandidates.slice(0, 12)) {
    console.log("[LP REWARD CANDIDATE]");
    console.log(`Market: ${candidate.title}`);
    if (candidate.marketSlug) console.log(`Slug: ${candidate.marketSlug}`);
    console.log(`Daily rewards: ${fmtUsd(candidate.reward.estimatedRewardUsdPerDay)}`);
    console.log(`Reward spread: ${fmtCents(candidate.reward.rewardZoneDistanceCents)}`);
    console.log(`Classification: ${candidate.classification}`);
    if (candidate.warnings.length > 0) console.log(`Warnings: ${candidate.warnings.join("; ")}`);
    console.log("");
  }
  if (rewardCandidates.length === 0) console.log("No reward candidates found.");
}

export function printPolyMarketDetail(
  market: PolyMarket,
  pair: PolyTokenBookPair | undefined,
): void {
  console.log("POLYMARKET DETAIL");
  console.log("");
  console.log(`Title: ${market.title}`);
  console.log(`Condition ID: ${market.conditionId}`);
  if (market.marketSlug) console.log(`Slug: ${market.marketSlug}`);
  console.log(`Active: ${market.active}`);
  console.log(`Closed: ${market.closed}`);
  console.log(`Volume 24h: ${fmtUsd(market.volume24h)}`);
  console.log(`Reward market: ${market.reward.isRewardMarket ? "yes" : "no"}`);
  console.log(`Reward/day: ${fmtUsd(market.reward.ratePerDayUsd)}`);
  console.log(`Reward max spread: ${fmtCents(market.reward.rewardsMaxSpreadCents)}`);
  console.log(`Reward min size: ${market.reward.rewardsMinSize?.toFixed(2) ?? "unknown"}`);
  console.log("");
  if (!pair) {
    console.log("Orderbook pair unavailable.");
    return;
  }
  if (pair.yesToken) {
    console.log(`Token A (${pair.yesToken.outcome}) id=${pair.yesToken.tokenId}`);
    console.log(
      `  bid/ask: ${fmtPrice(pair.yesBook?.bestBid)} / ${fmtPrice(pair.yesBook?.bestAsk)}`,
    );
    console.log(
      `  spread: ${fmtCents(pair.yesBook?.spread !== undefined ? pair.yesBook.spread * 100 : undefined)}`,
    );
  }
  if (pair.noToken) {
    console.log(`Token B (${pair.noToken.outcome}) id=${pair.noToken.tokenId}`);
    console.log(`  bid/ask: ${fmtPrice(pair.noBook?.bestBid)} / ${fmtPrice(pair.noBook?.bestAsk)}`);
    console.log(
      `  spread: ${fmtCents(pair.noBook?.spread !== undefined ? pair.noBook.spread * 100 : undefined)}`,
    );
  }
}

function pct(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  return `${(value * 100).toFixed(2)}%`;
}

function fmtSeconds(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  return `${value.toFixed(1)}s`;
}

function reportLine(label: string, a: string, b: string, delta?: string): string {
  return `${label.padEnd(28)} cons=${a.padEnd(12)} bal=${b.padEnd(12)}${delta ? ` delta=${delta}` : ""}`;
}

function topRejects(value: Array<{ reason: string; count: number }>): string {
  if (value.length === 0) return "none";
  return value.map((entry) => `${entry.reason}=${entry.count}`).join(" | ");
}

function fmtHours(value: number): string {
  if (value > 0 && value < 0.01) return "<0.01";
  return value.toFixed(2);
}

function fillRate(fills: number, placed: number): string {
  if (placed <= 0) return "0.00%";
  return `${((fills / placed) * 100).toFixed(2)}%`;
}

export function printPolyPaperWatch(result: PolyPaperTickResult): void {
  const conservative = result.summaries.find((summary) => summary.model === "conservative");
  const balanced = result.summaries.find((summary) => summary.model === "balanced");
  if (!conservative || !balanced) {
    console.log(
      `[${new Date().toISOString().slice(11, 19)}] poly_paper markets=${result.scanMarkets} summaries unavailable`,
    );
    return;
  }
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] polyPaperSummary markets=${result.scanMarkets}`);
  console.log(
    `  conservative openOrders=${conservative.openOrders} rewardOpen=${conservative.openByLane.reward} fills=${conservative.fillsTotal} fillRate=${fillRate(
      conservative.fillsTotal,
      conservative.placedTotal,
    )} cash=${fmtUsd(conservative.cash)} tradingPnl=${fmtUsd(conservative.totalPnl)}`,
  );
  console.log(
    `  balanced     openOrders=${balanced.openOrders} rewardOpen=${balanced.openByLane.reward} fills=${balanced.fillsTotal} fillRate=${fillRate(
      balanced.fillsTotal,
      balanced.placedTotal,
    )} cash=${fmtUsd(balanced.cash)} tradingPnl=${fmtUsd(balanced.totalPnl)}`,
  );
  console.log(
    `  tick         cons(candidates=${conservative.candidateQuotes} placed=${conservative.placedTick} rejected=${conservative.rejectedQuotes} filled=${conservative.filledTick} expired=${conservative.expiredTick}) bal(candidates=${balanced.candidateQuotes} placed=${balanced.placedTick} rejected=${balanced.rejectedQuotes} filled=${balanced.filledTick} expired=${balanced.expiredTick})`,
  );
  console.log(
    `  lanesOpen     cons(r/s/p=${conservative.openByLane.reward}/${conservative.openByLane.spread}/${conservative.openByLane.parity}) bal(r/s/p=${balanced.openByLane.reward}/${balanced.openByLane.spread}/${balanced.openByLane.parity})`,
  );
  console.log(
    `  lifetime      cons(placed=${conservative.placedTotal} fills=${conservative.fillsTotal} rewardOrderHours=${fmtHours(
      conservative.rewardEligibleHours,
    )} runtimeHours=${fmtHours(conservative.runtimeHours)} parity=${conservative.parityFilled}/${conservative.parityAttempts}) bal(placed=${
      balanced.placedTotal
    } fills=${balanced.fillsTotal} rewardOrderHours=${fmtHours(balanced.rewardEligibleHours)} runtimeHours=${fmtHours(
      balanced.runtimeHours,
    )} parity=${balanced.parityFilled}/${balanced.parityAttempts})`,
  );
  console.log(
    `  rejectTop     cons=${topRejects(conservative.rejectReasonsTop)} bal=${topRejects(balanced.rejectReasonsTop)}`,
  );
}

export function printPolyPaperReport(
  _state: PolyPaperState,
  conservative: PolyPaperReport,
  balanced: PolyPaperReport,
): void {
  console.log("GHILLIE / POLYMARKET PAPER REPORT");
  console.log("");
  console.log(reportLine("Fill rate", pct(conservative.fillRate), pct(balanced.fillRate)));
  console.log(
    reportLine(
      "Median fill time",
      fmtSeconds(conservative.medianFillSeconds),
      fmtSeconds(balanced.medianFillSeconds),
    ),
  );
  console.log(
    reportLine(
      "P95 fill time",
      fmtSeconds(conservative.p95FillSeconds),
      fmtSeconds(balanced.p95FillSeconds),
    ),
  );
  console.log(
    reportLine(
      "Cancellation ratio",
      pct(conservative.cancellationRatio),
      pct(balanced.cancellationRatio),
    ),
  );
  console.log(
    reportLine(
      "Quote distance",
      conservative.quoteCompetitivenessBps !== undefined
        ? `${conservative.quoteCompetitivenessBps.toFixed(1)}bps`
        : "unknown",
      balanced.quoteCompetitivenessBps !== undefined
        ? `${balanced.quoteCompetitivenessBps.toFixed(1)}bps`
        : "unknown",
    ),
  );
  console.log(
    reportLine("Realised PnL", fmtUsd(conservative.realisedPnl), fmtUsd(balanced.realisedPnl)),
  );
  console.log(
    reportLine(
      "Unrealised PnL",
      fmtUsd(conservative.unrealisedPnl),
      fmtUsd(balanced.unrealisedPnl),
    ),
  );
  console.log(reportLine("Total PnL", fmtUsd(conservative.totalPnl), fmtUsd(balanced.totalPnl)));
  console.log(
    reportLine(
      "Reward eligible",
      `${conservative.rewardEligibleHours.toFixed(2)}h`,
      `${balanced.rewardEligibleHours.toFixed(2)}h`,
    ),
  );
  console.log(
    reportLine(
      "Parity conversion",
      pct(conservative.parityConversionRate),
      pct(balanced.parityConversionRate),
    ),
  );
  console.log(
    reportLine(
      "Parity edge decay",
      conservative.parityEdgeDecayBps !== undefined
        ? `${conservative.parityEdgeDecayBps.toFixed(1)}bps`
        : "unknown",
      balanced.parityEdgeDecayBps !== undefined
        ? `${balanced.parityEdgeDecayBps.toFixed(1)}bps`
        : "unknown",
    ),
  );
  console.log("");
  console.log(`Verdict conservative: ${conservative.verdict}`);
  console.log(`Verdict balanced: ${balanced.verdict}`);
}
