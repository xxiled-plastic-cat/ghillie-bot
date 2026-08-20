import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AlphaConfig } from "./alphaConfig.js";
import { emptyAlphaState } from "./alphaStateStore.js";
import type { AlphaMarket, AlphaOrderbook, AlphaQuote } from "./alphaTypes.js";
import { ensurePositionByAppId } from "./inventoryView.js";
import { buildPlanReviewPayload, isEntryQuote } from "./planReview/index.js";
import { generateQuotes } from "./quoteEngine.js";

const APP_ID = 3_100_000_001;
const LOCAL_YES_REWARD_BID = 0.495; // yesMid 0.50 minus 0.5c reward buffer
const AMAROK_YES_REWARD_BID = 0.41;

function testConfig(overrides: Partial<AlphaConfig> = {}): AlphaConfig {
  return {
    enableRewardLane: true,
    rewardRequireRealDaily: true,
    rewardZoneBufferCents: 0.5,
    minMidpoint: 0.05,
    maxMidpoint: 0.95,
    minMakerSpreadCents: 0,
    rewardTargetQuoteSizeUsd: 3,
    rewardMinOrderSizeUsd: 1,
    rewardMaxOrderSizeUsd: 10,
    enableSpreadLane: false,
    enableSpreadCapture: false,
    spreadTargetOrderSizeUsd: 2,
    spreadMinOrderSizeUsd: 1,
    spreadMaxOrderSizeUsd: 10,
    minSpreadCaptureCents: 1,
    minSpreadEntryMidpoint: 0.05,
    minSpreadExitMidpoint: 0.01,
    maxSpreadMidpoint: 0.95,
    spreadExitEdgeCents: 0.5,
    inventoryExitMaxNotionalUsd: 50,
    inventoryExitFullPosition: true,
    underwaterExitEnabled: false,
    underwaterExitMinAgeHours: 24,
    underwaterExitMaxLossCents: 2,
    underwaterExitMaxNotionalUsd: 10,
    underwaterExitMaxMarketLossUsd: 5,
    staleInventoryAgeHours: 72,
    staleInventoryMaxLossCents: 5,
    ...overrides,
  } as AlphaConfig;
}

function rewardMarket(overrides: Partial<AlphaMarket> = {}): AlphaMarket {
  return {
    id: "m1",
    marketAppId: APP_ID,
    slug: "sample",
    title: "Sample",
    status: "live",
    resolved: false,
    reward: {
      isRewardMarket: true,
      dailyRewardsUsd: 12,
      dailyRewardsSource: "api",
      maxRewardSpreadCents: 5,
      minContracts: 1,
    },
    raw: {},
    ...overrides,
  };
}

function twoSidedBook(marketAppId = APP_ID): AlphaOrderbook {
  return {
    marketId: "m1",
    marketAppId,
    source: "api",
    yesBid: 0.48,
    yesAsk: 0.52,
    yesMid: 0.5,
    yesSpread: 0.04,
    noBid: 0.48,
    noAsk: 0.52,
    noMid: 0.5,
    noSpread: 0.04,
    yesSideOrders: {
      bids: [{ price: 0.48, quantityShares: 20 }],
      asks: [{ price: 0.52, quantityShares: 20 }],
    },
    noSideOrders: {
      bids: [{ price: 0.48, quantityShares: 20 }],
      asks: [{ price: 0.52, quantityShares: 20 }],
    },
  };
}

function amarokQuote(
  partial: Partial<AlphaQuote> & Pick<AlphaQuote, "outcome" | "side" | "source">,
): AlphaQuote {
  const price = partial.price ?? AMAROK_YES_REWARD_BID;
  const sizeShares = partial.sizeShares ?? 8;
  return {
    id: partial.id ?? `amarok:${APP_ID}:${partial.outcome}:${partial.side}`,
    marketId: partial.marketId ?? "m1",
    marketAppId: partial.marketAppId ?? APP_ID,
    title: partial.title ?? "Sample",
    outcome: partial.outcome,
    side: partial.side,
    price,
    sizeShares,
    notionalUsd: partial.notionalUsd ?? price * sizeShares,
    reason: partial.reason ?? "Amarok suggested quote",
    rewardEligible: partial.rewardEligible ?? partial.source === "reward",
    source: partial.source,
  };
}

describe("quoteEngine Amarok suggested quotes", () => {
  it("uses Amarok suggested entry quotes when present instead of local rediscovery", () => {
    const market = rewardMarket({
      suggestedQuotes: [
        amarokQuote({
          outcome: "YES",
          side: "bid",
          source: "reward",
          price: AMAROK_YES_REWARD_BID,
          sizeShares: 8,
        }),
      ],
    });
    const quotes = generateQuotes(market, twoSidedBook(), emptyAlphaState(100), testConfig());
    const yesReward = quotes.filter(
      (quote) => quote.outcome === "YES" && quote.side === "bid" && quote.source === "reward",
    );
    assert.equal(yesReward.length, 1);
    assert.equal(yesReward[0]!.price, AMAROK_YES_REWARD_BID);
    assert.equal(yesReward[0]!.sizeShares, 8);
    assert.match(yesReward[0]!.reason, /Amarok/i);
    assert.notEqual(yesReward[0]!.price, LOCAL_YES_REWARD_BID);
  });

  it("falls back to the local engine when Amarok omits quotes", () => {
    const quotes = generateQuotes(
      rewardMarket(),
      twoSidedBook(),
      emptyAlphaState(100),
      testConfig(),
    );
    const yesReward = quotes.filter(
      (quote) => quote.outcome === "YES" && quote.side === "bid" && quote.source === "reward",
    );
    assert.equal(yesReward.length, 1);
    assert.equal(yesReward[0]!.price, LOCAL_YES_REWARD_BID);
    assert.doesNotMatch(yesReward[0]!.reason, /Amarok/i);
  });

  it("falls back locally for a missing leg when Amarok only covers YES", () => {
    const market = rewardMarket({
      suggestedQuotes: [
        amarokQuote({
          outcome: "YES",
          side: "bid",
          source: "reward",
          price: AMAROK_YES_REWARD_BID,
        }),
      ],
    });
    const quotes = generateQuotes(market, twoSidedBook(), emptyAlphaState(100), testConfig());
    const yesReward = quotes.find(
      (quote) => quote.outcome === "YES" && quote.source === "reward" && quote.side === "bid",
    );
    const noReward = quotes.find(
      (quote) => quote.outcome === "NO" && quote.source === "reward" && quote.side === "bid",
    );
    assert.equal(yesReward?.price, AMAROK_YES_REWARD_BID);
    assert.equal(noReward?.price, LOCAL_YES_REWARD_BID);
    assert.doesNotMatch(noReward?.reason ?? "", /Amarok/i);
  });

  it("still builds local spread quotes on a stub book when Amarok omits the spread leg", () => {
    const stub: AlphaMarket = {
      id: "spread-stub",
      marketAppId: APP_ID,
      title: "Spread stub",
      status: "live",
      resolved: false,
      reward: { isRewardMarket: false },
      raw: {},
    };
    const quotes = generateQuotes(
      stub,
      twoSidedBook(),
      emptyAlphaState(100),
      testConfig({
        enableRewardLane: false,
        enableSpreadLane: true,
        enableSpreadCapture: true,
      }),
    );
    const spreadBids = quotes.filter((quote) => quote.source === "spread" && quote.side === "bid");
    assert.ok(spreadBids.length >= 1);
    assert.equal(
      spreadBids.every((quote) => !/amarok/i.test(quote.reason)),
      true,
    );
  });

  it("still emits local inventory-exit asks when Amarok supplied entry quotes", () => {
    const state = emptyAlphaState(100);
    ensurePositionByAppId(state, { marketAppId: APP_ID, marketId: "m1", title: "Sample" });
    state.positionsByMarket[String(APP_ID)]!.yesShares = 10;
    state.positionsByMarket[String(APP_ID)]!.avgYesCost = 0.4;

    const market = rewardMarket({
      suggestedQuotes: [
        amarokQuote({
          outcome: "YES",
          side: "bid",
          source: "reward",
          price: AMAROK_YES_REWARD_BID,
        }),
      ],
    });
    const quotes = generateQuotes(market, twoSidedBook(), state, testConfig());
    const exits = quotes.filter((quote) => quote.source === "inventory_exit");
    assert.ok(exits.length >= 1);
    assert.equal(
      exits.every((quote) => quote.side === "ask" && !/amarok/i.test(quote.reason)),
      true,
    );
  });

  it("keeps plan-review payload custody-safe when Amarok quotes ride on a market with secrets in raw", () => {
    const market = rewardMarket({
      raw: {
        mnemonic:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        paymentSignature: "secret-payment-signature",
        unsignedTxnsBase64: ["AAAA"],
        executionTool: "amarok_get_execution_quote",
      },
      suggestedQuotes: [
        amarokQuote({
          outcome: "YES",
          side: "bid",
          source: "reward",
          price: AMAROK_YES_REWARD_BID,
        }),
      ],
    });
    const book = twoSidedBook();
    const quotes = generateQuotes(market, book, emptyAlphaState(100), testConfig());
    const payload = buildPlanReviewPayload({
      entryQuotes: quotes.filter(isEntryQuote),
      state: emptyAlphaState(100),
      orderbooks: new Map([[APP_ID, book]]),
      markets: new Map([[APP_ID, market]]),
      walletUsdc: 20,
      inventoryCeilingUsd: 40,
      maxSingleOrderUsd: 10,
    });
    const json = JSON.stringify(payload);
    assert.doesNotMatch(json, /mnemonic/i);
    assert.doesNotMatch(json, /paymentSignature/);
    assert.doesNotMatch(json, /unsignedTxnsBase64/);
    assert.doesNotMatch(json, /abandon abandon/);
    assert.doesNotMatch(json, /amarok_get_execution_quote/);
    assert.ok(payload.planned.some((entry) => entry.price === AMAROK_YES_REWARD_BID));
  });
});
