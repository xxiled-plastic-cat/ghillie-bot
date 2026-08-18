import type { OpenOrder } from "@alpha-arcade/sdk";

import { fromMicroUnits } from "./alphaClient.js";
import type { AlphaBotState, AlphaPaperOrder, LiveFillEvent } from "./alphaTypes.js";
import { applyAskFillToPosition, applyBidFillToPosition } from "./positionAccounting.js";

export type { LiveFillEvent } from "./alphaTypes.js";

export type ApplyLiveFillResult = {
  applied: boolean;
  realisedPnl: number;
  message: string;
};

const MICRO = 1_000_000;
const FILL_EPS = 1e-6;

export function liveFillEventId(escrowAppId: number, filledSharesAfter: number): string {
  const micro = Math.round(filledSharesAfter * MICRO);
  return `livefill:${escrowAppId}:${micro}`;
}

export function escrowCursorKey(escrowAppId: number): string {
  return String(escrowAppId);
}

function fmtSignedUsd(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(4)}`;
}

function hasAppliedEvent(state: AlphaBotState, eventId: string): boolean {
  return (state.liveFillEvents ?? []).some((event) => event.id === eventId);
}

function cursorFilled(cursor: Record<string, number> | undefined, escrowAppId: number): number {
  return cursor?.[escrowCursorKey(escrowAppId)] ?? 0;
}

/**
 * Detect fill deltas from wallet open orders (including fully filled rows still
 * returned by the API) relative to the idempotency cursor.
 */
export function detectFillDeltasFromWallet(input: {
  previousLiveOrders: AlphaPaperOrder[];
  walletOrders: OpenOrder[];
  cursor: Record<string, number>;
  observedAt?: string;
}): LiveFillEvent[] {
  const { previousLiveOrders, walletOrders, cursor } = input;
  const observedAt = input.observedAt ?? new Date().toISOString();
  const walletByEscrow = new Map(walletOrders.map((order) => [order.escrowAppId, order]));
  const events: LiveFillEvent[] = [];

  for (const previous of previousLiveOrders) {
    const escrowAppId = previous.liveEscrowAppId;
    if (escrowAppId === undefined) continue;

    const wallet = walletByEscrow.get(escrowAppId);
    const filledAfter = wallet
      ? (fromMicroUnits(wallet.quantityFilled) ?? 0)
      : previous.filledShares;
    const applied = cursorFilled(cursor, escrowAppId);
    const delta = filledAfter - applied;
    if (delta <= FILL_EPS) continue;

    const price = wallet ? (fromMicroUnits(wallet.price) ?? previous.price) : previous.price;
    events.push({
      id: liveFillEventId(escrowAppId, filledAfter),
      escrowAppId,
      marketAppId: previous.marketAppId,
      marketId: previous.marketId,
      outcome: previous.outcome,
      side: previous.side,
      shares: delta,
      price,
      priceSource: "limit",
      source: previous.source,
      filledSharesAfter: filledAfter,
      observedAt,
      title: previous.title,
      slug: previous.slug,
    });
  }

  return events;
}

/**
 * After fill events are applied, any closed escrow whose size is not fully
 * covered by the cursor is treated as a cancel of the unfilled remainder.
 */
export function detectClosedCancels(input: {
  closedOrders: AlphaPaperOrder[];
  cursor: Record<string, number>;
  observedAt?: string;
}): AlphaPaperOrder[] {
  const { closedOrders, cursor } = input;
  const observedAt = input.observedAt ?? new Date().toISOString();
  const cancelled: AlphaPaperOrder[] = [];

  for (const order of closedOrders) {
    const escrowAppId = order.liveEscrowAppId;
    if (escrowAppId === undefined) continue;
    const filled = cursorFilled(cursor, escrowAppId);
    const unfilled = Math.max(0, order.sizeShares - filled);
    if (unfilled <= FILL_EPS) continue;
    cancelled.push({
      ...order,
      status: "cancelled",
      remainingShares: unfilled,
      filledShares: Math.min(order.sizeShares, filled),
      updatedAt: observedAt,
    });
  }

  return cancelled;
}

export function inventorySideKey(marketAppId: number, outcome: "YES" | "NO"): string {
  return `${marketAppId}:${outcome}`;
}

export type ClosedOrderClassification = {
  fills: LiveFillEvent[];
  cancels: AlphaPaperOrder[];
};

/**
 * When an escrow disappears between ticks, decide fill vs cancel from inventory
 * evidence — never treat a cancel as a fill when the share delta is ~0.
 *
 * - ask: chain free+escrow short vs bot state by ~unfilled → fill remainder
 * - bid: chain free+escrow grew vs bot state by ~unfilled → fill remainder
 */
export function classifyClosedOrdersAgainstInventory(input: {
  closedOrders: AlphaPaperOrder[];
  cursor: Record<string, number>;
  /** Bot-state share counts before applying close fills */
  stateSharesBySide: Map<string, number>;
  /** Wallet free + remaining open sell-escrow after the closes */
  chainSharesBySide: Map<string, number>;
  observedAt?: string;
}): ClosedOrderClassification {
  const { closedOrders, cursor } = input;
  const observedAt = input.observedAt ?? new Date().toISOString();
  const stateSharesBySide = new Map(input.stateSharesBySide);
  const fills: LiveFillEvent[] = [];
  const cancels: AlphaPaperOrder[] = [];

  for (const order of closedOrders) {
    const escrowAppId = order.liveEscrowAppId;
    if (escrowAppId === undefined) continue;
    const filled = cursorFilled(cursor, escrowAppId);
    const unfilled = Math.max(0, order.sizeShares - filled);
    if (unfilled <= FILL_EPS) continue;

    const key = inventorySideKey(order.marketAppId, order.outcome);
    const stateShares = stateSharesBySide.get(key) ?? 0;
    const chainShares = input.chainSharesBySide.get(key) ?? 0;

    let fillShares = 0;
    if (order.side === "ask") {
      const missing = stateShares - chainShares;
      if (missing >= unfilled - FILL_EPS) fillShares = unfilled;
      else if (missing > FILL_EPS) fillShares = missing;
    } else {
      const gained = chainShares - stateShares;
      if (gained >= unfilled - FILL_EPS) fillShares = unfilled;
      else if (gained > FILL_EPS) fillShares = gained;
    }

    fillShares = Math.min(unfilled, Math.max(0, fillShares));
    const cancelShares = Math.max(0, unfilled - fillShares);

    if (fillShares > FILL_EPS) {
      const filledSharesAfter = filled + fillShares;
      fills.push({
        id: liveFillEventId(escrowAppId, filledSharesAfter),
        escrowAppId,
        marketAppId: order.marketAppId,
        marketId: order.marketId,
        outcome: order.outcome,
        side: order.side,
        shares: fillShares,
        price: order.price,
        priceSource: "limit",
        source: order.source,
        filledSharesAfter,
        observedAt,
        title: order.title,
        slug: order.slug,
      });
      if (order.side === "ask") {
        stateSharesBySide.set(key, Math.max(0, stateShares - fillShares));
      } else {
        stateSharesBySide.set(key, stateShares + fillShares);
      }
    }

    if (cancelShares > FILL_EPS) {
      cancels.push({
        ...order,
        status: "cancelled",
        remainingShares: cancelShares,
        filledShares: Math.min(order.sizeShares, filled + fillShares),
        updatedAt: observedAt,
      });
    }
  }

  return { fills, cancels };
}

export function buildPlaceTimeFillEvent(input: {
  order: AlphaPaperOrder;
  escrowAppId: number;
  matchedShares: number;
  matchedPrice?: number;
  observedAt?: string;
}): LiveFillEvent | undefined {
  const { order, escrowAppId, matchedShares, matchedPrice } = input;
  if (matchedShares <= FILL_EPS) return undefined;
  const filledSharesAfter = matchedShares;
  const price = matchedPrice !== undefined && matchedPrice > 0 ? matchedPrice : order.price;
  return {
    id: liveFillEventId(escrowAppId, filledSharesAfter),
    escrowAppId,
    marketAppId: order.marketAppId,
    marketId: order.marketId,
    outcome: order.outcome,
    side: order.side,
    shares: matchedShares,
    price,
    priceSource: matchedPrice !== undefined && matchedPrice > 0 ? "matched" : "limit",
    source: order.source,
    filledSharesAfter,
    observedAt: input.observedAt ?? new Date().toISOString(),
    title: order.title,
    slug: order.slug,
  };
}

export function applyLiveFillEvent(
  state: AlphaBotState,
  event: LiveFillEvent,
): ApplyLiveFillResult {
  state.liveFillEvents ??= [];
  state.liveFillCursorByEscrow ??= {};

  const key = escrowCursorKey(event.escrowAppId);
  const appliedCursor = state.liveFillCursorByEscrow[key] ?? 0;
  if (hasAppliedEvent(state, event.id) || appliedCursor + FILL_EPS >= event.filledSharesAfter) {
    return {
      applied: false,
      realisedPnl: 0,
      message: `Live fill skipped (already applied) ${event.id}`,
    };
  }

  const shares = event.shares;
  if (shares <= FILL_EPS) {
    return {
      applied: false,
      realisedPnl: 0,
      message: `Live fill skipped (zero shares) ${event.id}`,
    };
  }

  const orderLike = {
    marketId: event.marketId,
    marketAppId: event.marketAppId,
    slug: event.slug,
    title: event.title ?? `market ${event.marketAppId}`,
    outcome: event.outcome,
    price: event.price,
  };

  let realisedPnl = 0;
  if (event.side === "bid") {
    applyBidFillToPosition(state, orderLike, shares, event.price);
    if (event.source === "spread") state.strategyStats.spreadEntryFills += 1;
  } else {
    realisedPnl = applyAskFillToPosition(state, orderLike, shares, event.price, {
      updateCash: false,
    });
    if (event.source === "inventory_exit") {
      state.strategyStats.spreadExitFills += 1;
      state.strategyStats.spreadRealisedPnl += realisedPnl;
    }
  }

  state.liveFillEvents.push(event);
  state.liveFillCursorByEscrow[key] = event.filledSharesAfter;

  const title = event.title ?? `market ${event.marketAppId}`;
  const fillSnapshot: AlphaPaperOrder = {
    id: event.id,
    runMode: "live",
    marketId: event.marketId,
    marketAppId: event.marketAppId,
    slug: event.slug,
    title,
    outcome: event.outcome,
    side: event.side,
    price: event.price,
    sizeShares: event.shares,
    notionalUsd: event.price * event.shares,
    reason: `live fill (${event.priceSource})`,
    rewardEligible: false,
    source: event.source,
    createdAt: event.observedAt,
    updatedAt: event.observedAt,
    status: "filled",
    reservedUsd: 0,
    filledShares: event.shares,
    remainingShares: 0,
    liveEscrowAppId: event.escrowAppId,
  };
  state.fills.push(fillSnapshot);

  const message =
    event.side === "bid"
      ? `Live entry fill ${title} ${event.outcome} bid ${shares.toFixed(6)} share(s) at ${event.price.toFixed(3)}`
      : `Live exit fill ${title} ${event.outcome} ask ${shares.toFixed(6)} share(s) at ${event.price.toFixed(3)}; spreadPnl=${fmtSignedUsd(realisedPnl)}`;

  return { applied: true, realisedPnl, message };
}

export function applyLiveFillEvents(
  state: AlphaBotState,
  events: LiveFillEvent[],
): Array<ApplyLiveFillResult & { event: LiveFillEvent }> {
  return events.map((event) => ({ event, ...applyLiveFillEvent(state, event) }));
}
