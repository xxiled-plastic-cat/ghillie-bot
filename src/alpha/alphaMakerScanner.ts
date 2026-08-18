import type { AlphaConfig } from "./alphaConfig.js";
import type { AlphaMarket, AlphaOpportunity, AlphaOrderbook } from "./alphaTypes.js";

export function rankMakerCandidates(
  markets: AlphaMarket[],
  books: Map<number, AlphaOrderbook>,
  config: AlphaConfig,
): AlphaOpportunity[] {
  const candidates: AlphaOpportunity[] = [];
  for (const market of markets) {
    const book = books.get(market.marketAppId);
    if (!book || book.bestSpread === undefined) continue;
    const midpoint = book.yesMid ?? book.noMid;
    if (midpoint === undefined || midpoint < config.minMidpoint || midpoint > config.maxMidpoint)
      continue;
    if (!market.reward.isRewardMarket && book.bestSpread * 100 < config.minMakerSpreadCents)
      continue;
    candidates.push({
      type: "MAKER",
      marketId: market.id,
      marketAppId: market.marketAppId,
      slug: market.slug,
      title: market.title,
      confidence: market.reward.isRewardMarket ? "high" : "medium",
      classification: "CANDIDATE",
      reason: market.reward.isRewardMarket
        ? "reward market with usable book"
        : `spread=${(book.bestSpread * 100).toFixed(2)}c`,
      requiredAction: "place risk-approved resting limit quotes",
      warnings: market.reward.isRewardMarket ? [] : ["non-reward spread capture is secondary"],
      reward: {
        rewardEligible: market.reward.isRewardMarket,
        estimatedRewardUsdPerDay: market.reward.dailyRewardsUsd,
        rewardZoneDistanceCents: market.reward.maxRewardSpreadCents,
        competitionLevel: market.reward.competitionLevel,
      },
    });
  }
  return candidates.sort(
    (a, b) => (b.reward.estimatedRewardUsdPerDay ?? 0) - (a.reward.estimatedRewardUsdPerDay ?? 0),
  );
}
