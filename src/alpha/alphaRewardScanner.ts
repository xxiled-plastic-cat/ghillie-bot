import type { AlphaConfig } from "./alphaConfig.js";
import type { AlphaMarket, AlphaOpportunity, AlphaOrderbook } from "./alphaTypes.js";

const COMPETITION_WEIGHT: Record<NonNullable<AlphaMarket["reward"]["competitionLevel"]>, number> = {
  low: 3,
  medium: 2,
  high: 1,
  unknown: 1.5,
};

function competitionAllowed(
  value: AlphaMarket["reward"]["competitionLevel"],
  max: AlphaConfig["maxRewardCompetition"],
): boolean {
  const ranks = { low: 0, medium: 1, high: 2, unknown: 1 };
  return ranks[value ?? "unknown"] <= ranks[max];
}

function midpointFor(book: AlphaOrderbook): number | undefined {
  return (
    book.yesMid ??
    (book.yesBid !== undefined && book.yesAsk !== undefined
      ? (book.yesBid + book.yesAsk) / 2
      : undefined)
  );
}

export function rankRewardCandidates(
  markets: AlphaMarket[],
  books: Map<number, AlphaOrderbook>,
  config: AlphaConfig,
): AlphaOpportunity[] {
  const opportunities: AlphaOpportunity[] = [];
  for (const market of markets) {
    const book = books.get(market.marketAppId);
    const midpoint = book ? midpointFor(book) : market.yesPrice;
    const dailyReward = market.reward.dailyRewardsUsd ?? market.reward.lastPayoutUsd;
    const maxSpread = market.reward.maxRewardSpreadCents;
    const warnings: string[] = [];
    if (!market.reward.isRewardMarket) continue;
    if (market.resolved || market.status !== "live") warnings.push("market is not live");
    if (dailyReward !== undefined && dailyReward < config.minDailyRewardUsd)
      warnings.push("daily reward below configured minimum");
    if (maxSpread === undefined) warnings.push("reward spread metadata unavailable");
    if (market.reward.minContracts === undefined)
      warnings.push("minimum aggregate reward size unavailable");
    if (maxSpread !== undefined && maxSpread < config.minRewardZoneCents)
      warnings.push("reward zone is very tight");
    if (!competitionAllowed(market.reward.competitionLevel, config.maxRewardCompetition))
      warnings.push("competition above configured maximum");
    if (midpoint === undefined) warnings.push("midpoint unavailable");
    if (midpoint !== undefined && (midpoint < config.minMidpoint || midpoint > config.maxMidpoint))
      warnings.push("midpoint outside configured range");
    if (!book || book.source === "unavailable") warnings.push("orderbook unavailable");

    const score =
      (dailyReward ?? 0) * 10 +
      (maxSpread ?? 0) * 2 +
      COMPETITION_WEIGHT[market.reward.competitionLevel ?? "unknown"] * 5 -
      warnings.length * 10;
    if (warnings.length > 0 && dailyReward === undefined) continue;
    opportunities.push({
      type: "LP_REWARD",
      marketId: market.id,
      marketAppId: market.marketAppId,
      slug: market.slug,
      title: market.title,
      confidence: warnings.length === 0 ? "high" : "medium",
      classification: warnings.length === 0 ? "CANDIDATE" : "OBSERVATION",
      reason: `rewardScore=${score.toFixed(1)}, dailyReward=${dailyReward?.toFixed(2) ?? "unknown"}, aggregateMinContracts=${
        market.reward.minContracts?.toFixed(6) ?? "unknown"
      }`,
      requiredAction: "place reward-qualified resting limit orders near midpoint",
      warnings,
      reward: {
        rewardEligible: warnings.length === 0,
        estimatedRewardUsdPerHour: dailyReward !== undefined ? dailyReward / 24 : undefined,
        estimatedRewardUsdPerDay: dailyReward,
        rewardZoneDistanceCents: maxSpread,
        competitionLevel: market.reward.competitionLevel,
        rewardReason:
          maxSpread !== undefined
            ? `quote inside +/-${maxSpread.toFixed(2)}c reward zone`
            : "reward zone unknown",
      },
    });
  }
  return opportunities.sort((a, b) => {
    const rewardDiff =
      (b.reward.estimatedRewardUsdPerDay ?? 0) - (a.reward.estimatedRewardUsdPerDay ?? 0);
    if (rewardDiff !== 0) return rewardDiff;
    return (b.reward.rewardZoneDistanceCents ?? 0) - (a.reward.rewardZoneDistanceCents ?? 0);
  });
}
