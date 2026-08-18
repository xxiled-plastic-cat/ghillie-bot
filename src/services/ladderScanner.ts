import type { Ladder, LadderOpportunity } from "../types/market.js";
import { applyTakerMatchFeeBps, toBps } from "../utils/math.js";

export function scanLadderInversions(ladders: Ladder[], minEdgeBps: number): LadderOpportunity[] {
  const opportunities: LadderOpportunity[] = [];
  for (const ladder of ladders) {
    for (let lowerIndex = 0; lowerIndex < ladder.markets.length; lowerIndex += 1) {
      for (
        let higherIndex = lowerIndex + 1;
        higherIndex < ladder.markets.length;
        higherIndex += 1
      ) {
        const lower = ladder.markets[lowerIndex];
        const higher = ladder.markets[higherIndex];
        if (lower?.yesAsk === undefined || higher?.yesBid === undefined) continue;
        if (higher.yesBid <= lower.yesAsk) continue;

        const edgeBps = toBps((higher.yesBid - lower.yesAsk) / lower.yesAsk);
        if (edgeBps < minEdgeBps) continue;

        opportunities.push({
          type: "ladder_inversion",
          underlying: ladder.underlying,
          timeframe: ladder.timeframe,
          expiryTs: ladder.expiryTs,
          lowerMarketId: lower.id,
          higherMarketId: higher.id,
          lowerStrike: lower.strike,
          higherStrike: higher.strike,
          lowerYesAsk: lower.yesAsk,
          higherYesBid: higher.yesBid,
          edgeBps,
          takerAdjustedEdgeBps: applyTakerMatchFeeBps(edgeBps),
        });
      }
    }
  }

  return opportunities.sort((a, b) => b.edgeBps - a.edgeBps);
}
