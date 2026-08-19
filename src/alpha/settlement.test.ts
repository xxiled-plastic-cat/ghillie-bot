import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { emptyAlphaState } from "./alphaStateStore.js";
import type { AlphaPaperPosition } from "./alphaTypes.js";
import { applyMergeToState, computeMergeSets } from "./inventoryMerger.js";
import { getPosition, positionKey } from "./inventoryView.js";
import { realiseStaleSide } from "./liveTrader.js";
import { planBuyMergeUnwind, planSplitSellResidual } from "./parityTrader.js";
import { applyClaimedFreeSharesToState } from "./resolvedClaimLane.js";

const APP_ID = 1001;

function position(partial: Partial<AlphaPaperPosition> = {}): AlphaPaperPosition {
  return {
    marketId: partial.marketId ?? "m1",
    marketAppId: partial.marketAppId ?? APP_ID,
    title: partial.title ?? "Test Market",
    yesShares: partial.yesShares ?? 0,
    noShares: partial.noShares ?? 0,
    avgYesCost: partial.avgYesCost ?? 0,
    avgNoCost: partial.avgNoCost ?? 0,
    realisedPnl: partial.realisedPnl ?? 0,
    unrealisedPnl: partial.unrealisedPnl ?? 0,
    lastMark: partial.lastMark ?? 0.5,
    unaccountedTicks: partial.unaccountedTicks,
    slug: partial.slug,
  };
}

describe("computeMergeSets", () => {
  it("returns 0 when inventory is escrow-only (no free matched sets)", () => {
    const sets = computeMergeSets({
      freeYes: 0,
      freeNo: 0,
      stateYes: 10,
      stateNo: 10,
      escrowYes: 10,
      escrowNo: 10,
    });
    assert.equal(sets, 0);
  });

  it("caps free matched sets by tracked free-equivalent (state − escrow)", () => {
    const sets = computeMergeSets({
      freeYes: 8,
      freeNo: 8,
      stateYes: 10,
      stateNo: 10,
      escrowYes: 6,
      escrowNo: 3,
    });
    // free matched=8, freeYesTracked=4, freeNoTracked=7 → 4
    assert.equal(sets, 4);
  });

  it("merges free matched sets and realises PnL without clearing escrow remainder", () => {
    const state = emptyAlphaState(100);
    state.positionsByMarket[positionKey(APP_ID)] = position({
      yesShares: 10,
      noShares: 10,
      avgYesCost: 0.4,
      avgNoCost: 0.4,
    });
    const sets = computeMergeSets({
      freeYes: 5,
      freeNo: 5,
      stateYes: 10,
      stateNo: 10,
      escrowYes: 5,
      escrowNo: 5,
    });
    assert.equal(sets, 5);
    const realised = applyMergeToState(state, APP_ID, sets);
    assert.ok(Math.abs(realised - (1 - 0.4 - 0.4) * 5) < 1e-9);
    const remaining = getPosition(state, APP_ID);
    assert.ok(remaining);
    assert.equal(remaining!.yesShares, 5);
    assert.equal(remaining!.noShares, 5);
    assert.equal(remaining!.avgYesCost, 0.4);
  });
});

describe("applyClaimedFreeSharesToState", () => {
  it("subtracts free claimed shares and leaves escrow inventory in state", () => {
    const state = emptyAlphaState(100);
    state.positionsByMarket[positionKey(APP_ID)] = position({
      yesShares: 10,
      noShares: 0,
      avgYesCost: 0.4,
    });
    const applied = applyClaimedFreeSharesToState(state, APP_ID, "YES", 4, 1);
    assert.ok(applied.realised !== undefined);
    assert.ok(Math.abs((applied.realised ?? 0) - (4 - 4 * 0.4)) < 1e-9);
    assert.equal(applied.remaining, 6);
    const remaining = getPosition(state, APP_ID);
    assert.ok(remaining);
    assert.equal(remaining!.yesShares, 6);
    assert.equal(remaining!.avgYesCost, 0.4);
  });

  it("does not invent realised PnL for void/unknown outcomes", () => {
    const state = emptyAlphaState(100);
    state.positionsByMarket[positionKey(APP_ID)] = position({
      yesShares: 5,
      avgYesCost: 0.5,
    });
    const before = state.realisedPnl;
    const applied = applyClaimedFreeSharesToState(state, APP_ID, "YES", 5, 99);
    assert.equal(applied.realised, undefined);
    assert.equal(state.realisedPnl, before);
    assert.equal(getPosition(state, APP_ID), undefined);
  });
});

describe("realiseStaleSide", () => {
  it("does not realise or mutate for unresolved gaps before sustained absence", () => {
    const pos = position({ yesShares: 3, avgYesCost: 0.4, lastMark: 0.7 });
    const result = realiseStaleSide(pos, "YES", 3, { isResolved: false });
    assert.equal(result.allowMutate, false);
    assert.equal(result.realisePnl, false);
    assert.equal(result.realised, 0);
  });

  it("prunes sustained unresolved absence without mark write-off PnL", () => {
    const pos = position({ yesShares: 3, avgYesCost: 0.4, lastMark: 0.7 });
    const result = realiseStaleSide(
      pos,
      "YES",
      3,
      { isResolved: false },
      { sustainedAbsence: true },
    );
    assert.equal(result.allowMutate, true);
    assert.equal(result.realisePnl, false);
    assert.equal(result.realised, 0);
    assert.match(result.note, /sustained absence/);
  });

  it("realises PnL for resolved YES/NO outcomes", () => {
    const pos = position({ yesShares: 3, avgYesCost: 0.4 });
    const won = realiseStaleSide(pos, "YES", 3, { isResolved: true, outcome: 1 });
    assert.equal(won.allowMutate, true);
    assert.equal(won.realisePnl, true);
    assert.ok(Math.abs(won.realised - (3 - 3 * 0.4)) < 1e-9);

    const lost = realiseStaleSide(pos, "YES", 3, { isResolved: true, outcome: 0 });
    assert.equal(lost.realisePnl, true);
    assert.ok(Math.abs(lost.realised - (0 - 3 * 0.4)) < 1e-9);
  });

  it("prunes void/unknown without mark write-off PnL", () => {
    const pos = position({ yesShares: 3, avgYesCost: 0.4, lastMark: 0.9 });
    const result = realiseStaleSide(pos, "YES", 3, { isResolved: true, outcome: 99 });
    assert.equal(result.allowMutate, true);
    assert.equal(result.realisePnl, false);
    assert.equal(result.realised, 0);
  });
});

describe("parity residual helpers", () => {
  it("plans buy-merge unwind residual when unwind fails after first leg", () => {
    const planned = planBuyMergeUnwind({
      filledOutcome: "YES",
      failedLeg: "NO buy",
      marketAppId: APP_ID,
      title: "Test",
      shares: 2,
      unwindSucceeded: false,
      unwindError: "slippage",
    });
    assert.ok(planned.residual);
    assert.equal(planned.residual!.kind, "buy_merge_one_side");
    assert.equal(planned.residual!.outcome, "YES");
    assert.match(planned.reason, /stranded/);
  });

  it("plans split-sell residual when merge-back fails", () => {
    const planned = planSplitSellResidual({
      marketAppId: APP_ID,
      title: "Test",
      shares: 2,
      failedLeg: "YES sell",
      mergeBackSucceeded: false,
      mergeBackError: "budget",
    });
    assert.ok(planned.residual);
    assert.equal(planned.residual!.kind, "split_sell_unmatched");
  });
});
