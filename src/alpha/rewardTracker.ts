import type { AlphaConfig } from "./alphaConfig.js";
import type { AlphaBotState, AlphaPaperOrder } from "./alphaTypes.js";
import { estimateRewardRateForOrders, type RewardRateContext } from "./rewardRateEstimator.js";

function groupOrdersByMarket(orders: AlphaPaperOrder[]): Map<number, AlphaPaperOrder[]> {
  const byMarket = new Map<number, AlphaPaperOrder[]>();
  for (const order of orders) {
    const existing = byMarket.get(order.marketAppId) ?? [];
    existing.push(order);
    byMarket.set(order.marketAppId, existing);
  }
  return byMarket;
}

export function accrueEstimatedRewards(
  state: AlphaBotState,
  config: AlphaConfig,
  now = Date.now(),
  rewardContext: RewardRateContext = {},
): void {
  const last = Date.parse(state.lastUpdated);
  const elapsedSeconds = Number.isFinite(last) ? Math.max(0, (now - last) / 1000) : 0;
  if (elapsedSeconds <= 0) return;
  const activeOrders: AlphaPaperOrder[] = [];
  for (const order of state.openOrders) {
    if (order.status !== "open" || !order.rewardEligible) continue;
    const ageSeconds = Math.max(0, (now - Date.parse(order.createdAt)) / 1000);
    if (ageSeconds < config.rewardMinDwellSeconds) continue;
    activeOrders.push(order);
  }

  for (const [marketAppId, marketOrders] of groupOrdersByMarket(activeOrders)) {
    const rewardRate = estimateRewardRateForOrders(marketOrders, {
      ...rewardContext,
      walletAddress: rewardContext.walletAddress ?? config.walletAddress,
      calibration: config.rewardRateCalibration ?? rewardContext.calibration,
    });
    if (rewardRate.dailyUsd === undefined || rewardRate.dailyUsd <= 0) continue;
    const estimate = rewardRate.dailyUsd * (elapsedSeconds / 86_400);
    const marketRewardKey = String(marketAppId);
    state.estimatedRewardsUsd += estimate;
    state.estimatedRewardsByMarket[marketRewardKey] =
      (state.estimatedRewardsByMarket[marketRewardKey] ?? 0) + estimate;
    state.rewardEligibleSeconds += elapsedSeconds;
  }
}
