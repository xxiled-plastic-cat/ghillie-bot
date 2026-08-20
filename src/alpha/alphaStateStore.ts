import { type BotStateStore, createBotStateStore } from "../integrations/storage/botStateStore.js";
import type { AlphaBotState } from "./alphaTypes.js";
import { migratePositionsToAppIdKeys } from "./inventoryView.js";

const MAX_HISTORY = 500;

let storeOverride: BotStateStore | undefined;

/** Test hook — inject a store (e.g. local FS temp dir). */
export function setAlphaStateStoreForTests(store: BotStateStore | undefined): void {
  storeOverride = store;
}

function getStore(): BotStateStore {
  return storeOverride ?? createBotStateStore();
}

export function emptyAlphaState(startingBalance: number): AlphaBotState {
  const now = new Date().toISOString();
  return {
    startingBalance,
    cash: startingBalance,
    openOrders: [],
    positionsByMarket: {},
    realisedPnl: 0,
    unrealisedPnl: 0,
    estimatedRewardsUsd: 0,
    estimatedRewardsByMarket: {},
    spreadStatsByMarket: {},
    parityAttempts: [],
    rewardEligibleSeconds: 0,
    totalPnl: 0,
    fills: [],
    cancelledOrders: [],
    liveFillEvents: [],
    liveFillCursorByEscrow: {},
    strategyStats: {
      ticks: 0,
      rewardMarketsSeen: 0,
      candidatesSeen: 0,
      quotesPlaced: 0,
      liveOrdersPlaced: 0,
      liveOrdersCancelled: 0,
      spreadEntryFills: 0,
      spreadExitFills: 0,
      spreadRealisedPnl: 0,
      parityTradesExecuted: 0,
      parityGrossPnl: 0,
      parityNetPnlEstimate: 0,
      parityFailedLegs: 0,
    },
    notificationState: {},
    lastUpdated: now,
  };
}

function normalizeAlphaState(parsed: AlphaBotState, startingBalance: number): AlphaBotState {
  const state: AlphaBotState = {
    ...emptyAlphaState(startingBalance),
    ...parsed,
    openOrders: Array.isArray(parsed.openOrders) ? parsed.openOrders : [],
    fills: Array.isArray(parsed.fills) ? parsed.fills : [],
    cancelledOrders: Array.isArray(parsed.cancelledOrders) ? parsed.cancelledOrders : [],
    liveFillEvents: Array.isArray(parsed.liveFillEvents) ? parsed.liveFillEvents : [],
    liveFillCursorByEscrow: parsed.liveFillCursorByEscrow ?? {},
    parityAttempts: Array.isArray(parsed.parityAttempts) ? parsed.parityAttempts : [],
    positionsByMarket: parsed.positionsByMarket ?? {},
    estimatedRewardsByMarket: parsed.estimatedRewardsByMarket ?? {},
    spreadStatsByMarket: parsed.spreadStatsByMarket ?? {},
    strategyStats: {
      ...emptyAlphaState(startingBalance).strategyStats,
      ...parsed.strategyStats,
    },
    notificationState: parsed.notificationState ?? {},
    x402Spend: parsed.x402Spend,
    capitalLedger: parsed.capitalLedger,
  };
  migratePositionsToAppIdKeys(state);
  return state;
}

export async function loadAlphaState(key: string, startingBalance: number): Promise<AlphaBotState> {
  const raw = await getStore().getJson(key);
  if (raw === undefined || raw === null) return emptyAlphaState(startingBalance);
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Alpha bot state at key ${JSON.stringify(key)} is not a JSON object`);
  }
  return normalizeAlphaState(raw as AlphaBotState, startingBalance);
}

export async function saveAlphaState(key: string, state: AlphaBotState): Promise<void> {
  const bounded: AlphaBotState = {
    ...state,
    fills: state.fills.slice(-MAX_HISTORY),
    cancelledOrders: state.cancelledOrders.slice(-MAX_HISTORY),
    liveFillEvents: (state.liveFillEvents ?? []).slice(-MAX_HISTORY),
    liveFillCursorByEscrow: state.liveFillCursorByEscrow ?? {},
    parityAttempts: state.parityAttempts.slice(-MAX_HISTORY),
    totalPnl: state.realisedPnl + state.unrealisedPnl,
    lastUpdated: new Date().toISOString(),
  };
  await getStore().putJson(key, bounded);
}
