import type { PolyConfig } from "./polyConfig.js";
import type { PolyMarket, PolyOpportunity, PolyTokenBookPair } from "./polyTypes.js";

function midpointFromPair(pair: PolyTokenBookPair): number | undefined {
  const values = [pair.yesBook?.midpoint, pair.noBook?.midpoint].filter(
    (value): value is number => value !== undefined,
  );
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function rankPolyRewardCandidates(
  markets: PolyMarket[],
  booksByCondition: Map<string, PolyTokenBookPair>,
  config: PolyConfig,
): PolyOpportunity[] {
  if (!config.enableRewardLane) return [];
  const candidates: PolyOpportunity[] = [];
  for (const market of markets) {
    if (!market.reward.isRewardMarket) continue;
    const warnings: string[] = [];
    const pair = booksByCondition.get(market.conditionId);
    const midpoint = pair ? midpointFromPair(pair) : undefined;
    const daily = market.reward.ratePerDayUsd;
    const maxSpreadCents = market.reward.rewardsMaxSpreadCents;
    if (!market.active || market.closed) warnings.push("market not active");
    if (daily === undefined) warnings.push("daily reward missing");
    if (daily !== undefined && daily < config.minDailyRewardUsd)
      warnings.push("daily reward below minimum");
    if (maxSpreadCents === undefined) warnings.push("reward spread missing");
    if (maxSpreadCents !== undefined && maxSpreadCents < config.minRewardZoneCents)
      warnings.push("reward spread too tight");
    if (market.reward.rewardsMinSize === undefined) warnings.push("reward min size missing");
    if (!pair || (!pair.yesBook && !pair.noBook)) warnings.push("orderbook missing");
    if (midpoint === undefined) warnings.push("midpoint unavailable");
    if (
      midpoint !== undefined &&
      (midpoint < config.minMidpoint || midpoint > config.maxMidpoint)
    ) {
      warnings.push("midpoint outside configured range");
    }
    const confidence: PolyOpportunity["confidence"] =
      warnings.length === 0 ? "high" : warnings.length <= 2 ? "medium" : "low";
    const bestSpreadCents =
      Math.max((pair?.yesBook?.spread ?? 0) * 100, (pair?.noBook?.spread ?? 0) * 100) || undefined;
    candidates.push({
      type: "LP_REWARD",
      conditionId: market.conditionId,
      marketSlug: market.marketSlug,
      title: market.title,
      confidence,
      classification: warnings.length === 0 ? "CANDIDATE" : "OBSERVATION",
      reason: `daily=${daily?.toFixed(2) ?? "unknown"} maxSpread=${maxSpreadCents?.toFixed(2) ?? "unknown"}c minSize=${
        market.reward.rewardsMinSize?.toFixed(2) ?? "unknown"
      }`,
      warnings,
      reward: {
        rewardEligible: warnings.length === 0,
        estimatedRewardUsdPerDay: daily,
        rewardZoneDistanceCents: maxSpreadCents,
      },
      spread: {
        yesSpreadCents: pair?.yesBook?.spread !== undefined ? pair.yesBook.spread * 100 : undefined,
        noSpreadCents: pair?.noBook?.spread !== undefined ? pair.noBook.spread * 100 : undefined,
        bestSpreadCents,
      },
    });
  }
  return candidates.sort(
    (a, b) => (b.reward.estimatedRewardUsdPerDay ?? 0) - (a.reward.estimatedRewardUsdPerDay ?? 0),
  );
}
