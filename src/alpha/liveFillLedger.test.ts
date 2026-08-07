import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { OpenOrder } from "@alpha-arcade/sdk";

import { emptyAlphaState } from "./alphaStateStore.js";
import type { AlphaPaperOrder } from "./alphaTypes.js";
import { getPosition } from "./inventoryView.js";
import {
  applyLiveFillEvent,
  applyLiveFillEvents,
  buildPlaceTimeFillEvent,
  classifyClosedOrdersAgainstInventory,
  detectClosedCancels,
  detectFillDeltasFromWallet,
  escrowCursorKey,
  inventorySideKey,
  liveFillEventId,
} from "./liveFillLedger.js";

const MICRO = 1_000_000;
const APP_ID = 1001;

function order(partial: Partial<AlphaPaperOrder> & Pick<AlphaPaperOrder, "liveEscrowAppId" | "side" | "outcome">): AlphaPaperOrder {
  const sizeShares = partial.sizeShares ?? 10;
  const filledShares = partial.filledShares ?? 0;
  return {
    id: `live:${partial.liveEscrowAppId}`,
    runMode: "live",
    marketId: partial.marketId ?? "m1",
    marketAppId: partial.marketAppId ?? APP_ID,
    title: partial.title ?? "Test Market",
    outcome: partial.outcome,
    side: partial.side,
    price: partial.price ?? 0.4,
    sizeShares,
    notionalUsd: (partial.price ?? 0.4) * sizeShares,
    reason: "test",
    rewardEligible: false,
    source: partial.source ?? "spread",
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-01-01T00:00:00.000Z",
    status: partial.status ?? "open",
    reservedUsd: 0,
    filledShares,
    remainingShares: partial.remainingShares ?? sizeShares - filledShares,
    liveEscrowAppId: partial.liveEscrowAppId,
    slug: partial.slug,
  };
}

function walletOrder(partial: Partial<OpenOrder> & Pick<OpenOrder, "escrowAppId" | "quantityFilled">): OpenOrder {
  return {
    escrowAppId: partial.escrowAppId,
    marketAppId: partial.marketAppId ?? APP_ID,
    position: partial.position ?? 1,
    side: partial.side ?? 1,
    price: partial.price ?? 400_000,
    quantity: partial.quantity ?? 10 * MICRO,
    quantityFilled: partial.quantityFilled,
    slippage: 0,
    owner: partial.owner ?? "TESTWALLET",
  };
}

describe("liveFillLedger", () => {
  it("updates VWAP on partial fill before close", () => {
    const state = emptyAlphaState(100);
    const previous = [order({ liveEscrowAppId: 55, side: "bid", outcome: "YES", price: 0.4, sizeShares: 10, filledShares: 0 })];
    const events = detectFillDeltasFromWallet({
      previousLiveOrders: previous,
      walletOrders: [walletOrder({ escrowAppId: 55, quantityFilled: 4 * MICRO })],
      cursor: {},
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.shares, 4);
    const result = applyLiveFillEvent(state, events[0]!);
    assert.equal(result.applied, true);
    assert.match(result.message, /^Live entry fill/);
    const position = getPosition(state, APP_ID);
    assert.ok(position);
    assert.equal(position.yesShares, 4);
    assert.equal(position.avgYesCost, 0.4);
    assert.equal(state.liveFillCursorByEscrow?.[escrowCursorKey(55)], 4);
  });

  it("is idempotent when quantityFilled is unchanged", () => {
    const state = emptyAlphaState(100);
    const previous = [order({ liveEscrowAppId: 55, side: "bid", outcome: "YES", filledShares: 4 })];
    const walletOrders = [walletOrder({ escrowAppId: 55, quantityFilled: 4 * MICRO })];
    const first = detectFillDeltasFromWallet({ previousLiveOrders: previous, walletOrders, cursor: {} });
    applyLiveFillEvents(state, first);
    const second = detectFillDeltasFromWallet({
      previousLiveOrders: previous,
      walletOrders,
      cursor: state.liveFillCursorByEscrow ?? {},
    });
    assert.equal(second.length, 0);
    const again = applyLiveFillEvent(state, first[0]!);
    assert.equal(again.applied, false);
    assert.equal(getPosition(state, APP_ID)?.yesShares, 4);
  });

  it("cancels closed orders with no fill delta and does not invent PnL", () => {
    const state = emptyAlphaState(100);
    state.realisedPnl = 0;
    const closed = [order({ liveEscrowAppId: 77, side: "bid", outcome: "YES", sizeShares: 5, filledShares: 0 })];
    const events = detectFillDeltasFromWallet({
      previousLiveOrders: closed,
      walletOrders: [],
      cursor: {},
    });
    assert.equal(events.length, 0);
    const cancelled = detectClosedCancels({ closedOrders: closed, cursor: {} });
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0]?.remainingShares, 5);
    assert.equal(state.realisedPnl, 0);
    assert.equal(Object.keys(state.positionsByMarket).length, 0);
  });

  it("infers ask fill on close when inventory is missing the unfilled size", () => {
    const state = emptyAlphaState(100);
    state.positionsByMarket[String(APP_ID)] = {
      marketId: "m1",
      marketAppId: APP_ID,
      title: "Test Market",
      yesShares: 10,
      noShares: 0,
      avgYesCost: 0.4,
      avgNoCost: 0,
      realisedPnl: 0,
      unrealisedPnl: 0,
    };
    const closed = [order({ liveEscrowAppId: 91, side: "ask", outcome: "YES", price: 0.55, sizeShares: 4, filledShares: 0 })];
    const classified = classifyClosedOrdersAgainstInventory({
      closedOrders: closed,
      cursor: {},
      stateSharesBySide: new Map([[inventorySideKey(APP_ID, "YES"), 10]]),
      chainSharesBySide: new Map([[inventorySideKey(APP_ID, "YES"), 6]]),
    });
    assert.equal(classified.fills.length, 1);
    assert.equal(classified.cancels.length, 0);
    assert.equal(classified.fills[0]?.shares, 4);
    const result = applyLiveFillEvent(state, classified.fills[0]!);
    assert.equal(result.applied, true);
    assert.match(result.message, /^Live exit fill/);
    assert.equal(getPosition(state, APP_ID)?.yesShares, 6);
  });

  it("treats ask close as cancel when inventory still holds the shares", () => {
    const closed = [order({ liveEscrowAppId: 92, side: "ask", outcome: "YES", sizeShares: 4, filledShares: 0 })];
    const classified = classifyClosedOrdersAgainstInventory({
      closedOrders: closed,
      cursor: {},
      stateSharesBySide: new Map([[inventorySideKey(APP_ID, "YES"), 10]]),
      chainSharesBySide: new Map([[inventorySideKey(APP_ID, "YES"), 10]]),
    });
    assert.equal(classified.fills.length, 0);
    assert.equal(classified.cancels.length, 1);
    assert.equal(classified.cancels[0]?.remainingShares, 4);
  });

  it("applies remaining fill on close then ignores restart replay via cursor", () => {
    const state = emptyAlphaState(100);
    const closed = [order({ liveEscrowAppId: 88, side: "bid", outcome: "YES", price: 0.5, sizeShares: 10, filledShares: 10 })];
    const events = detectFillDeltasFromWallet({
      previousLiveOrders: closed,
      walletOrders: [],
      cursor: {},
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.shares, 10);
    applyLiveFillEvents(state, events);
    assert.equal(getPosition(state, APP_ID)?.yesShares, 10);
    assert.equal(getPosition(state, APP_ID)?.avgYesCost, 0.5);

    const replay = detectFillDeltasFromWallet({
      previousLiveOrders: closed,
      walletOrders: [],
      cursor: state.liveFillCursorByEscrow ?? {},
    });
    assert.equal(replay.length, 0);
    const cancelled = detectClosedCancels({
      closedOrders: closed,
      cursor: state.liveFillCursorByEscrow ?? {},
    });
    assert.equal(cancelled.length, 0);
  });

  it("realises ask PnL against bid VWAP", () => {
    const state = emptyAlphaState(100);
    const bid = {
      id: liveFillEventId(1, 10),
      escrowAppId: 1,
      marketAppId: APP_ID,
      marketId: "m1",
      outcome: "YES" as const,
      side: "bid" as const,
      shares: 10,
      price: 0.4,
      priceSource: "limit" as const,
      source: "spread" as const,
      filledSharesAfter: 10,
      observedAt: "2026-01-01T00:00:00.000Z",
      title: "Test Market",
    };
    const ask = {
      ...bid,
      id: liveFillEventId(2, 4),
      escrowAppId: 2,
      side: "ask" as const,
      source: "inventory_exit" as const,
      shares: 4,
      price: 0.55,
      filledSharesAfter: 4,
    };
    applyLiveFillEvent(state, bid);
    const exit = applyLiveFillEvent(state, ask);
    assert.equal(exit.applied, true);
    assert.match(exit.message, /^Live exit fill/);
    assert.ok(Math.abs(exit.realisedPnl - (0.55 - 0.4) * 4) < 1e-9);
    assert.equal(getPosition(state, APP_ID)?.yesShares, 6);
    assert.equal(state.strategyStats.spreadExitFills, 1);
  });

  it("applies place-time matched fills at matchedPrice", () => {
    const state = emptyAlphaState(100);
    const placed = order({ liveEscrowAppId: 99, side: "bid", outcome: "NO", price: 0.3, sizeShares: 8 });
    const event = buildPlaceTimeFillEvent({
      order: placed,
      escrowAppId: 99,
      matchedShares: 3,
      matchedPrice: 0.29,
    });
    assert.ok(event);
    assert.equal(event?.priceSource, "matched");
    assert.equal(event?.price, 0.29);
    const result = applyLiveFillEvent(state, event!);
    assert.equal(result.applied, true);
    assert.equal(getPosition(state, APP_ID)?.noShares, 3);
    assert.equal(getPosition(state, APP_ID)?.avgNoCost, 0.29);
  });
});
