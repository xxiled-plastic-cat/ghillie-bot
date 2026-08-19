import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AlphaConfig } from "./alphaConfig.js";
import {
  checkQuoteRisk,
  getAskCoverageUsd,
  getInventoryNotionalUsd,
  getNetExposureUsd,
  getTotalExposure,
} from "./alphaRiskManager.js";
import { emptyAlphaState } from "./alphaStateStore.js";
import type { AlphaPaperOrder, AlphaQuote } from "./alphaTypes.js";
import { ensurePositionByAppId } from "./inventoryView.js";

const APP_ID = 2001;

function testConfig(overrides: Partial<AlphaConfig> = {}): AlphaConfig {
  return {
    inventoryExitMaxNotionalUsd: 50,
    rewardMaxOrderSizeUsd: 10,
    spreadMaxOrderSizeUsd: 10,
    rewardMaxMarketExposureUsd: 100,
    spreadMaxMarketExposureUsd: 100,
    rewardMaxTotalExposureUsd: 100,
    spreadMaxTotalExposureUsd: 100,
    rewardMaxLiveOpenOrders: 10,
    spreadMaxLiveOpenOrders: 10,
    rewardMaxLiveOrdersPerMarket: 5,
    spreadMaxLiveOrdersPerMarket: 5,
    maxInventoryNotionalUsd: 0,
    ...overrides,
  } as AlphaConfig;
}

function quote(
  partial: Partial<AlphaQuote> & Pick<AlphaQuote, "side" | "source" | "outcome">,
): AlphaQuote {
  const price = partial.price ?? 0.4;
  const sizeShares = partial.sizeShares ?? 5;
  return {
    id: partial.id ?? "q1",
    marketId: partial.marketId ?? "m1",
    marketAppId: partial.marketAppId ?? APP_ID,
    title: partial.title ?? "Test",
    outcome: partial.outcome,
    side: partial.side,
    price,
    sizeShares,
    notionalUsd: partial.notionalUsd ?? price * sizeShares,
    reason: partial.reason ?? "test",
    rewardEligible: partial.rewardEligible ?? false,
    source: partial.source,
  };
}

function openOrder(
  partial: Partial<AlphaPaperOrder> & Pick<AlphaPaperOrder, "side" | "outcome" | "source">,
): AlphaPaperOrder {
  const price = partial.price ?? 0.4;
  const remainingShares = partial.remainingShares ?? partial.sizeShares ?? 5;
  return {
    id: partial.id ?? `live:${partial.liveEscrowAppId ?? 1}`,
    runMode: partial.runMode ?? "live",
    marketId: partial.marketId ?? "m1",
    marketAppId: partial.marketAppId ?? APP_ID,
    title: partial.title ?? "Test",
    outcome: partial.outcome,
    side: partial.side,
    price,
    sizeShares: partial.sizeShares ?? remainingShares,
    notionalUsd: price * remainingShares,
    reason: partial.reason ?? "test",
    rewardEligible: false,
    source: partial.source,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "open",
    reservedUsd: partial.side === "bid" ? price * remainingShares : 0,
    filledShares: 0,
    remainingShares,
    liveEscrowAppId: partial.liveEscrowAppId ?? 1,
  };
}

describe("alphaRiskManager exposure", () => {
  it("uses the same total exposure formula for live and paper", () => {
    const state = emptyAlphaState(100);
    ensurePositionByAppId(state, { marketAppId: APP_ID, marketId: "m1", title: "Test" });
    const position = state.positionsByMarket[String(APP_ID)]!;
    position.yesShares = 10;
    position.avgYesCost = 0.4;

    // Inventory-only: mode filter is irrelevant → live/paper/dry-run match.
    assert.equal(getTotalExposure(state, "live"), getTotalExposure(state, "paper"));
    assert.equal(getTotalExposure(state, "live"), getTotalExposure(state, "live-dry-run"));
    assert.ok(Math.abs(getTotalExposure(state, "live") - 4) < 1e-9);

    state.openOrders = [
      openOrder({
        side: "bid",
        outcome: "YES",
        source: "spread",
        price: 0.3,
        remainingShares: 2,
        runMode: "live",
      }),
      openOrder({
        side: "ask",
        outcome: "YES",
        source: "inventory_exit",
        price: 0.5,
        remainingShares: 4,
        runMode: "live",
        liveEscrowAppId: 2,
      }),
    ];
    const expected = 0.3 * 2 + 10 * 0.4 - 4 * 0.4;
    assert.equal(getTotalExposure(state, "live"), getTotalExposure(state, "live-dry-run"));
    assert.ok(Math.abs(getTotalExposure(state, "live") - expected) < 1e-9);
  });

  it("counts inventory alone in live net exposure", () => {
    const state = emptyAlphaState(100);
    ensurePositionByAppId(state, { marketAppId: APP_ID, marketId: "m1", title: "Test" });
    const position = state.positionsByMarket[String(APP_ID)]!;
    position.yesShares = 8;
    position.avgYesCost = 0.5;
    assert.equal(getInventoryNotionalUsd(state), 4);
    assert.equal(getNetExposureUsd(state, "live"), 4);
    assert.equal(getTotalExposure(state, "live"), 4);
  });

  it("reduces net exposure by ask coverage at avg cost", () => {
    const state = emptyAlphaState(100);
    ensurePositionByAppId(state, { marketAppId: APP_ID, marketId: "m1", title: "Test" });
    const position = state.positionsByMarket[String(APP_ID)]!;
    position.yesShares = 10;
    position.avgYesCost = 0.4;
    state.openOrders = [
      openOrder({
        side: "ask",
        outcome: "YES",
        source: "inventory_exit",
        remainingShares: 6,
        runMode: "live",
      }),
    ];
    assert.ok(Math.abs(getAskCoverageUsd(state, "live") - 2.4) < 1e-9);
    assert.ok(Math.abs(getNetExposureUsd(state, "live") - (4 - 2.4)) < 1e-9);
  });

  it("blocks entry bids when inventory notional is at the governor ceiling", () => {
    const state = emptyAlphaState(100);
    ensurePositionByAppId(state, { marketAppId: APP_ID, marketId: "m1", title: "Test" });
    const position = state.positionsByMarket[String(APP_ID)]!;
    position.yesShares = 10;
    position.avgYesCost = 0.5; // $5 inventory
    const config = testConfig({
      maxInventoryNotionalUsd: 5,
      spreadMaxTotalExposureUsd: 100,
      spreadMaxMarketExposureUsd: 100,
    });
    const decision = checkQuoteRisk(
      quote({ side: "bid", source: "spread", outcome: "YES", price: 0.4, sizeShares: 1 }),
      state,
      config,
      "live",
    );
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /ALPHA_MAX_INVENTORY_NOTIONAL_USD/);
  });

  it("allows inventory_exit asks when held shares cover size", () => {
    const state = emptyAlphaState(100);
    ensurePositionByAppId(state, { marketAppId: APP_ID, marketId: "m1", title: "Test" });
    const position = state.positionsByMarket[String(APP_ID)]!;
    position.yesShares = 10;
    position.avgYesCost = 0.4;
    const decision = checkQuoteRisk(
      quote({ side: "ask", source: "inventory_exit", outcome: "YES", price: 0.5, sizeShares: 4 }),
      state,
      testConfig(),
      "live",
    );
    assert.equal(decision.allowed, true);
  });

  it("blocks asks that would sell more than held inventory", () => {
    const state = emptyAlphaState(100);
    ensurePositionByAppId(state, { marketAppId: APP_ID, marketId: "m1", title: "Test" });
    const position = state.positionsByMarket[String(APP_ID)]!;
    position.yesShares = 2;
    position.avgYesCost = 0.4;
    const decision = checkQuoteRisk(
      quote({ side: "ask", source: "inventory_exit", outcome: "YES", price: 0.5, sizeShares: 3 }),
      state,
      testConfig(),
      "live",
    );
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /more shares than current inventory/);
  });
});
