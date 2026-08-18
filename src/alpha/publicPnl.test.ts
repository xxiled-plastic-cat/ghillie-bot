import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DashboardRealPnl } from "./alphaDashboardData.js";
import { buildGhilliePublicPnl } from "./publicPnl.js";

describe("buildGhilliePublicPnl", () => {
  const realPnl: DashboardRealPnl = {
    contributedCapitalUsd: 100,
    netWorthUsd: 125.5,
    bidEscrowUsd: 10,
    cashUsdc: 40,
    positionsValueUsd: 75.5,
    rewardsReceivedUsd: 1.25,
    marketUsdcInUsd: 200,
    marketUsdcOutUsd: 80,
    tradingPnlUsd: 12.5,
    realisedPnlUsd: 8,
    unrealisedPnlUsd: 4.5,
    estimatedRewardsUsd: 0.5,
    totalEconomicUsd: 13.75,
    externalCapitalDriftUsd: 0,
  };

  it("marks pnl unavailable without a prior nav snapshot", () => {
    const payload = buildGhilliePublicPnl({
      walletAddress: "TESTADDR",
      asOf: "2026-08-07T12:00:00.000Z",
      realPnl,
    });
    assert.equal(payload.agentId, "ghillie");
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.pnlAvailable, false);
    assert.equal(payload.summary.pnlAvailable, false);
    assert.equal(payload.summary.navUsd, "125.500000");
    assert.equal(payload.summary.tradingPnlUsd, "12.500000");
  });

  it("computes pnl vs prior public nav", () => {
    const payload = buildGhilliePublicPnl({
      walletAddress: "TESTADDR",
      asOf: "2026-08-07T13:00:00.000Z",
      realPnl,
      previous: {
        summary: { navUsd: "120.000000" },
      },
    });
    assert.equal(payload.pnlAvailable, true);
    assert.equal(payload.summary.pnlUsd, "5.500000");
    assert.equal(payload.pnlUsd, "5.500000");
  });
});
