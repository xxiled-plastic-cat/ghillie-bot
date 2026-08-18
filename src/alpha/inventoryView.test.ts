import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { OpenOrder, WalletPosition } from "@alpha-arcade/sdk";

import { emptyAlphaState } from "./alphaStateStore.js";
import {
  buildInventorySnapshot,
  getPosition,
  inventoryInvariantMismatches,
  migratePositionsToAppIdKeys,
  positionKey,
  syncPositionsFromInventory,
} from "./inventoryView.js";
import { applyBidFillToPosition, ensurePosition } from "./positionAccounting.js";

const MICRO = 1_000_000;
const APP_ID = 1001;

function walletPosition(
  partial: Partial<WalletPosition> & Pick<WalletPosition, "marketAppId">,
): WalletPosition {
  return {
    marketAppId: partial.marketAppId,
    title: partial.title ?? "Test Market",
    yesAssetId: partial.yesAssetId ?? 1,
    noAssetId: partial.noAssetId ?? 2,
    yesBalance: partial.yesBalance ?? 0,
    noBalance: partial.noBalance ?? 0,
  };
}

function walletOrder(
  partial: Partial<OpenOrder> & Pick<OpenOrder, "escrowAppId" | "marketAppId" | "position">,
): OpenOrder {
  return {
    escrowAppId: partial.escrowAppId,
    marketAppId: partial.marketAppId,
    position: partial.position,
    side: partial.side ?? 0,
    price: partial.price ?? 500_000,
    quantity: partial.quantity ?? 5 * MICRO,
    quantityFilled: partial.quantityFilled ?? 0,
    slippage: 0,
    owner: partial.owner ?? "TEST",
  };
}

describe("inventoryView", () => {
  it("migrates UUID + String(appId) duplicates onto one canonical key", () => {
    const state = emptyAlphaState(100);
    state.positionsByMarket["uuid-market"] = {
      marketId: "uuid-market",
      marketAppId: APP_ID,
      title: "UUID keyed",
      yesShares: 8,
      noShares: 0,
      avgYesCost: 0.4,
      avgNoCost: 0,
      realisedPnl: 1,
      unrealisedPnl: 0,
    };
    state.positionsByMarket[String(APP_ID)] = {
      marketId: String(APP_ID),
      marketAppId: APP_ID,
      title: "AppId keyed",
      yesShares: 3,
      noShares: 1,
      avgYesCost: 0,
      avgNoCost: 0.55,
      realisedPnl: 2,
      unrealisedPnl: 0,
    };

    const removed = migratePositionsToAppIdKeys(state);
    assert.ok(removed >= 1);
    assert.equal(Object.keys(state.positionsByMarket).length, 1);
    const position = getPosition(state, APP_ID);
    assert.ok(position);
    assert.equal(positionKey(APP_ID) in state.positionsByMarket, true);
    assert.equal(position?.yesShares, 8);
    assert.equal(position?.avgYesCost, 0.4);
    assert.equal(position?.avgNoCost, 0.55);
    assert.equal(position?.realisedPnl, 3);
  });

  it("builds snapshot totals as free + sell-escrow", () => {
    const snapshot = buildInventorySnapshot(
      [walletPosition({ marketAppId: APP_ID, yesBalance: 2 * MICRO, noBalance: 0 })],
      [
        walletOrder({
          escrowAppId: 9,
          marketAppId: APP_ID,
          position: 1,
          quantity: 3 * MICRO,
          quantityFilled: 0,
        }),
      ],
    );
    const inventory = snapshot.get(APP_ID);
    assert.ok(inventory);
    assert.equal(inventory?.yes.free, 2);
    assert.equal(inventory?.yes.escrow, 3);
    assert.equal(inventory?.yes.total, 5);
  });

  it("preserves avg cost when free drops because shares moved to escrow", () => {
    const state = emptyAlphaState(100);
    ensurePosition(state, {
      marketId: "uuid-market",
      marketAppId: APP_ID,
      title: "Test Market",
    });
    applyBidFillToPosition(
      state,
      {
        marketId: "uuid-market",
        marketAppId: APP_ID,
        title: "Test Market",
        outcome: "YES",
        price: 0.4,
      },
      5,
      0.4,
    );
    assert.equal(getPosition(state, APP_ID)?.avgYesCost, 0.4);

    const snapshot = buildInventorySnapshot(
      [walletPosition({ marketAppId: APP_ID, yesBalance: 1 * MICRO })],
      [walletOrder({ escrowAppId: 9, marketAppId: APP_ID, position: 1, quantity: 4 * MICRO })],
    );
    syncPositionsFromInventory(state, snapshot);
    const position = getPosition(state, APP_ID);
    assert.equal(position?.yesShares, 5);
    assert.equal(position?.avgYesCost, 0.4);
  });

  it("clears avg only when total inventory hits zero", () => {
    const state = emptyAlphaState(100);
    ensurePosition(state, { marketId: "m", marketAppId: APP_ID, title: "Test" });
    applyBidFillToPosition(
      state,
      { marketId: "m", marketAppId: APP_ID, title: "Test", outcome: "NO", price: 0.6 },
      2,
      0.6,
    );
    syncPositionsFromInventory(
      state,
      buildInventorySnapshot(
        [walletPosition({ marketAppId: APP_ID, yesBalance: 0, noBalance: 0 })],
        [],
      ),
    );
    // Market absent from snapshot with zero balances — sync does not auto-wipe
    // tracked rows that are only missing from wallet; clearing happens when
    // snapshot includes the market with total 0, so force an empty total row:
    const emptySnapshot = new Map([
      [
        APP_ID,
        {
          marketAppId: APP_ID,
          yes: { free: 0, escrow: 0, total: 0 },
          no: { free: 0, escrow: 0, total: 0 },
        },
      ],
    ]);
    syncPositionsFromInventory(state, emptySnapshot);
    const position = getPosition(state, APP_ID);
    assert.equal(position?.noShares, 0);
    assert.equal(position?.avgNoCost, 0);
  });

  it("reports invariant mismatches when state diverges from snapshot", () => {
    const state = emptyAlphaState(100);
    ensurePosition(state, { marketId: "m", marketAppId: APP_ID, title: "Test" });
    const position = getPosition(state, APP_ID)!;
    position.yesShares = 9;
    position.avgYesCost = 0.5;

    const snapshot = buildInventorySnapshot(
      [walletPosition({ marketAppId: APP_ID, yesBalance: 2 * MICRO })],
      [],
    );
    // Intentionally do not sync — state is inflated vs wallet.
    const mismatches = inventoryInvariantMismatches(state, snapshot);
    assert.equal(mismatches.length, 1);
    assert.match(mismatches[0]!.message, /Inventory invariant/);
  });

  it("ensurePosition / fill apply land under appId key", () => {
    const state = emptyAlphaState(100);
    ensurePosition(state, { marketId: "uuid-only", marketAppId: APP_ID, title: "Test" });
    applyBidFillToPosition(
      state,
      { marketId: "uuid-only", marketAppId: APP_ID, title: "Test", outcome: "YES", price: 0.25 },
      1,
      0.25,
    );
    assert.equal("uuid-only" in state.positionsByMarket, false);
    assert.equal(positionKey(APP_ID) in state.positionsByMarket, true);
    assert.equal(getPosition(state, APP_ID)?.yesShares, 1);
  });
});
