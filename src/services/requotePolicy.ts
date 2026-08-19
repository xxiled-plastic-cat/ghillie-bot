import type { BotState, ExecutionConfig, RequoteDecision, TopTarget } from "../types/execution.js";
import { targetKey } from "./targetSelector.js";

function minutesUntil(unixTs: number): number {
  return (unixTs - Date.now() / 1000) / 60;
}

function countMovesInLastHour(state: BotState, config: ExecutionConfig): number {
  const cutoff = Date.now() - 60 * 60 * 1000;
  return state.moveHistory.filter(
    (move) => move.mode === config.executionMode && new Date(move.movedAt).getTime() >= cutoff,
  ).length;
}

function secondsSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 1000;
}

export function decideRequote(
  state: BotState,
  topTarget: TopTarget | undefined,
  config: ExecutionConfig,
): RequoteDecision {
  if (!topTarget) {
    return {
      action: "skip",
      reason: "no executable top target passed scoring, halt, and risk filters",
    };
  }

  if (minutesUntil(topTarget.haltTs) <= config.haltBlockMinutes) {
    return { action: "skip", reason: "top target is inside halt block", topTarget };
  }

  if (countMovesInLastHour(state, config) >= config.maxMovesPerHour) {
    return {
      action: "skip",
      reason: `max moves per hour reached (${config.maxMovesPerHour})`,
      topTarget,
    };
  }

  const active = state.activeTarget;
  if (!active) {
    return { action: "move", reason: "no active target; open initial quotes", topTarget };
  }

  const activeKey = `${active.marketId}:${active.strikeIndex}`;
  const nextKey = targetKey(topTarget);
  const activeAgeSeconds = secondsSince(active.placedAt);
  const scoreDeltaPct =
    active.targetScore > 0
      ? ((topTarget.targetScore - active.targetScore) / active.targetScore) * 100
      : 100;

  if (minutesUntil(topTarget.haltTs) <= config.haltBlockMinutes) {
    return {
      action: "move",
      reason: "active target approaching halt block; rotate to safer target",
      topTarget,
    };
  }

  if (activeAgeSeconds < config.minDwellSeconds && activeKey !== nextKey) {
    return {
      action: "hold",
      reason: `minimum dwell not met (${activeAgeSeconds.toFixed(0)}s < ${config.minDwellSeconds}s)`,
      topTarget,
    };
  }

  if (activeKey === nextKey) {
    const priceChanged =
      active.yesBuyPriceCents !== topTarget.yesBuyPriceCents ||
      active.noBuyPriceCents !== topTarget.noBuyPriceCents;
    if (!priceChanged) {
      return {
        action: "hold",
        reason: "current target remains top target with same quote levels",
        topTarget,
      };
    }
    return { action: "move", reason: "same target but quote levels changed", topTarget };
  }

  if (scoreDeltaPct < config.moveScoreDeltaPct) {
    return {
      action: "hold",
      reason: `new target score delta ${scoreDeltaPct.toFixed(1)}% below threshold ${config.moveScoreDeltaPct}%`,
      topTarget,
    };
  }

  return {
    action: "move",
    reason: `new target beats active by ${scoreDeltaPct.toFixed(1)}%`,
    topTarget,
  };
}
