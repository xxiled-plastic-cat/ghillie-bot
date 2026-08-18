import type { PolyConfig } from "./polyConfig.js";
import type { PolyMarket, PolyOpportunity, PolyTokenBookPair } from "./polyTypes.js";

function sideDepthUsd(pair: PolyTokenBookPair): number {
  const yes = pair.yesBook;
  const no = pair.noBook;
  const yesDepth =
    yes?.bids[0] && yes.asks[0]
      ? Math.min(yes.bids[0].price * yes.bids[0].size, yes.asks[0].price * yes.asks[0].size)
      : 0;
  const noDepth =
    no?.bids[0] && no.asks[0]
      ? Math.min(no.bids[0].price * no.bids[0].size, no.asks[0].price * no.asks[0].size)
      : 0;
  return Math.max(yesDepth, noDepth);
}

export function rankPolySpreadCandidates(
  markets: PolyMarket[],
  booksByCondition: Map<string, PolyTokenBookPair>,
  config: PolyConfig,
): PolyOpportunity[] {
  if (!config.enableSpreadLane) return [];
  const candidates: PolyOpportunity[] = [];
  for (const market of markets) {
    const pair = booksByCondition.get(market.conditionId);
    if (!pair) continue;
    const spreads = [pair.yesBook?.spread, pair.noBook?.spread].filter(
      (value): value is number => value !== undefined,
    );
    if (spreads.length === 0) continue;
    const bestSpread = Math.max(...spreads);
    const midpointValues = [pair.yesBook?.midpoint, pair.noBook?.midpoint].filter(
      (value): value is number => value !== undefined,
    );
    const midpoint =
      midpointValues.length > 0
        ? midpointValues.reduce((sum, value) => sum + value, 0) / midpointValues.length
        : undefined;
    const bestDepthUsd = sideDepthUsd(pair);
    const warnings: string[] = [];
    if (market.reward.isRewardMarket) warnings.push("reward market; spread lane is secondary");
    if ((market.volume24h ?? 0) < config.minSpreadVolumeUsd)
      warnings.push("24h volume below minimum");
    if (bestSpread * 100 < config.minSpreadCaptureCents) warnings.push("spread below minimum");
    if (bestDepthUsd < config.minSpreadDepthUsd) warnings.push("depth below minimum");
    if (midpoint === undefined) warnings.push("midpoint unavailable");
    if (
      midpoint !== undefined &&
      (midpoint < config.minSpreadEntryMidpoint || midpoint > config.maxSpreadMidpoint)
    ) {
      warnings.push("midpoint outside spread-entry range");
    }
    candidates.push({
      type: "SPREAD",
      conditionId: market.conditionId,
      marketSlug: market.marketSlug,
      title: market.title,
      confidence: warnings.length === 0 ? "high" : warnings.length <= 2 ? "medium" : "low",
      classification: warnings.length === 0 ? "CANDIDATE" : "OBSERVATION",
      reason: `spread=${(bestSpread * 100).toFixed(2)}c depth=$${bestDepthUsd.toFixed(2)} volume24h=$${(market.volume24h ?? 0).toFixed(0)}`,
      warnings,
      reward: {
        rewardEligible: false,
      },
      spread: {
        yesSpreadCents: pair.yesBook?.spread !== undefined ? pair.yesBook.spread * 100 : undefined,
        noSpreadCents: pair.noBook?.spread !== undefined ? pair.noBook.spread * 100 : undefined,
        bestSpreadCents: bestSpread * 100,
        bestDepthUsd,
      },
    });
  }
  return candidates.sort(
    (a, b) => (b.spread?.bestSpreadCents ?? 0) - (a.spread?.bestSpreadCents ?? 0),
  );
}
