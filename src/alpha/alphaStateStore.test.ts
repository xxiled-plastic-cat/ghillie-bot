import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalFilesystemBotStateStore } from "../integrations/storage/botStateStore.js";
import {
  emptyAlphaState,
  loadAlphaState,
  saveAlphaState,
  setAlphaStateStoreForTests,
} from "./alphaStateStore.js";

test("loadAlphaState / saveAlphaState round-trip via local BotStateStore", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "ghillie-alpha-state-"));
  const store = new LocalFilesystemBotStateStore({ rootDir, prefix: "ghillie-bot" });
  setAlphaStateStoreForTests(store);
  try {
    const missing = await loadAlphaState("alpha", 100);
    assert.equal(missing.cash, 100);
    assert.deepEqual(missing.openOrders, []);

    const state = emptyAlphaState(100);
    state.cash = 55;
    state.realisedPnl = 12.5;
    state.positionsByMarket["3162451457"] = {
      marketId: "3162451457",
      marketAppId: 3162451457,
      title: "test",
      yesShares: 2,
      noShares: 0,
      avgYesCost: 0.4,
      avgNoCost: 0,
      realisedPnl: 0,
      unrealisedPnl: 0,
    };
    await saveAlphaState("alpha", state);

    const loaded = await loadAlphaState("alpha", 100);
    assert.equal(loaded.cash, 55);
    assert.equal(loaded.realisedPnl, 12.5);
    assert.equal(loaded.positionsByMarket["3162451457"]?.yesShares, 2);
    assert.ok(loaded.lastUpdated);
  } finally {
    setAlphaStateStoreForTests(undefined);
    await rm(rootDir, { recursive: true, force: true });
  }
});
