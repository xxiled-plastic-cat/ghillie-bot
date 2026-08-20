import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResponsesClient } from "../../integrations/zerosignal/index.js";
import type { AlphaConfig } from "../alphaConfig.js";
import { emptyAlphaState } from "../alphaStateStore.js";
import type { AlphaMarket, AlphaOrderbook, AlphaQuote } from "../alphaTypes.js";
import { ensurePositionByAppId } from "../inventoryView.js";
import {
  applyPlanReviewDecisions,
  buildPlanReviewPayload,
  computePostFillInventory,
  entryReviewId,
  extractJsonObjectText,
  PLAN_REVIEW_PROMPT,
  parsePlanReviewResponse,
  runPlanReview,
} from "./index.js";

const APP_ID = 3162451457;

function testConfig(overrides: Partial<AlphaConfig> = {}): AlphaConfig {
  return {
    rewardMaxOrderSizeUsd: 10,
    spreadMaxOrderSizeUsd: 10,
    maxInventoryNotionalUsd: 40,
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
    title: partial.title ?? "Test market",
    outcome: partial.outcome,
    side: partial.side,
    price,
    sizeShares,
    notionalUsd: partial.notionalUsd ?? price * sizeShares,
    reason: partial.reason ?? "reward-zone bid near midpoint",
    rewardEligible: partial.rewardEligible ?? true,
    source: partial.source,
  };
}

function twoSidedBook(marketAppId = APP_ID): AlphaOrderbook {
  return {
    marketId: "m1",
    marketAppId,
    source: "api",
    yesBid: 0.39,
    yesAsk: 0.42,
    yesMid: 0.405,
    yesSpread: 0.03,
    noBid: 0.58,
    noAsk: 0.61,
    noMid: 0.595,
    noSpread: 0.03,
    yesSideOrders: {
      bids: [{ price: 0.39, quantityShares: 20 }],
      asks: [{ price: 0.42, quantityShares: 20 }],
    },
    noSideOrders: {
      bids: [{ price: 0.58, quantityShares: 20 }],
      asks: [{ price: 0.61, quantityShares: 20 }],
    },
  };
}

function market(
  marketAppId = APP_ID,
  extras: Pick<AlphaMarket, "endTs" | "closeTime"> = {},
): AlphaMarket {
  return {
    id: "m1",
    marketAppId,
    title: "Test market",
    status: "active",
    resolved: false,
    volume: 50,
    reward: { isRewardMarket: true, dailyRewardsUsd: 5 },
    raw: {},
    ...extras,
  };
}

function messageResponse(text: string) {
  return {
    id: "resp_1",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text }],
      },
    ],
    output_text: text,
  };
}

describe("planReview prompt", () => {
  it("includes Alpha market risk language (not financial advice; fail-closed incomplete data)", () => {
    assert.match(PLAN_REVIEW_PROMPT, /This is not financial advice/i);
    assert.match(PLAN_REVIEW_PROMPT, /fail-closed operational gate/i);
    assert.match(PLAN_REVIEW_PROMPT, /Skip\/veto/);
    assert.match(PLAN_REVIEW_PROMPT, /books, expiry, or inventory/);
    assert.match(PLAN_REVIEW_PROMPT, /Never invent a size/);
    assert.match(PLAN_REVIEW_PROMPT, /fail closed on that id instead/);
    assert.match(PLAN_REVIEW_PROMPT, /incomplete_data — book, expiry, or inventory/);
    assert.match(PLAN_REVIEW_PROMPT, /Do not shrink or approve when data is incomplete/);
  });

  it("keeps the OS base prompt generic (operator prefs stay out of band)", () => {
    assert.doesNotMatch(PLAN_REVIEW_PROMPT, /OPERATOR PREFERENCES/);
    assert.doesNotMatch(PLAN_REVIEW_PROMPT, /amarok_/);
    assert.doesNotMatch(PLAN_REVIEW_PROMPT, /ALPHA_ENABLE_/);
  });

  it("never mentions mnemonics, payment signatures, or execution tools", () => {
    assert.doesNotMatch(PLAN_REVIEW_PROMPT, /mnemonic/i);
    assert.doesNotMatch(PLAN_REVIEW_PROMPT, /paymentSignature/);
    assert.doesNotMatch(PLAN_REVIEW_PROMPT, /amarok_get_execution_quote/);
  });
});

describe("planReview payload", () => {
  it("computes post-fill inventory for a YES bid", () => {
    const state = emptyAlphaState(100);
    ensurePositionByAppId(state, { marketAppId: APP_ID, marketId: "m1", title: "Test market" });
    state.positionsByMarket[String(APP_ID)]!.yesShares = 2;
    state.positionsByMarket[String(APP_ID)]!.noShares = 1;

    const result = computePostFillInventory(
      state,
      quote({ side: "bid", outcome: "YES", source: "reward", sizeShares: 5 }),
    );
    assert.deepEqual(result, { yes: 7, no: 1 });
  });

  it("builds compact payload with book and post-fill inventory", () => {
    const state = emptyAlphaState(100);
    ensurePositionByAppId(state, { marketAppId: APP_ID, marketId: "m1", title: "Test market" });
    const entry = quote({
      side: "bid",
      outcome: "YES",
      source: "reward",
      price: 0.4,
      sizeShares: 5,
    });
    const payload = buildPlanReviewPayload({
      entryQuotes: [entry],
      state,
      orderbooks: new Map([[APP_ID, twoSidedBook()]]),
      markets: new Map([[APP_ID, market()]]),
      walletUsdc: 20,
      inventoryCeilingUsd: 40,
      maxSingleOrderUsd: 10,
    });

    assert.equal(payload.planned.length, 1);
    assert.equal(payload.planned[0]!.id, entryReviewId(entry, 0));
    assert.equal(payload.planned[0]!.book.twoSided, true);
    assert.equal(payload.planned[0]!.book.volume, 50);
    assert.deepEqual(payload.planned[0]!.expiry, {});
    assert.deepEqual(payload.planned[0]!.postFillInventory, { yes: 5, no: 0 });
    assert.equal(payload.portfolio.walletUsdc, 20);
  });

  it("includes expiry when the market has endTs/closeTime", () => {
    const state = emptyAlphaState(100);
    ensurePositionByAppId(state, { marketAppId: APP_ID, marketId: "m1", title: "Test market" });
    const entry = quote({
      side: "bid",
      outcome: "YES",
      source: "reward",
      price: 0.4,
      sizeShares: 5,
    });
    const payload = buildPlanReviewPayload({
      entryQuotes: [entry],
      state,
      orderbooks: new Map([[APP_ID, twoSidedBook()]]),
      markets: new Map([
        [APP_ID, market(APP_ID, { endTs: 1_700_000_000, closeTime: "2023-11-14T22:13:20.000Z" })],
      ]),
      walletUsdc: 20,
      inventoryCeilingUsd: 40,
      maxSingleOrderUsd: 10,
    });

    assert.deepEqual(payload.planned[0]!.expiry, {
      endTs: 1_700_000_000,
      closeTime: "2023-11-14T22:13:20.000Z",
    });
  });
});

describe("planReview schema", () => {
  it("extracts JSON from fenced markdown", () => {
    const text = '```json\n{"decisions":[{"id":"e1","action":"approve","reasons":[]}]}\n```';
    const extracted = extractJsonObjectText(text);
    assert.ok(extracted);
    const parsed = parsePlanReviewResponse(extracted!);
    assert.equal(parsed.decisions[0]!.action, "approve");
  });
});

describe("planReview apply", () => {
  it("keeps exits and drops entries on missing response (fail closed)", () => {
    const entry = quote({ side: "bid", outcome: "YES", source: "reward" });
    const exit = quote({
      side: "ask",
      outcome: "YES",
      source: "inventory_exit",
      price: 0.5,
      sizeShares: 2,
    });
    const applied = applyPlanReviewDecisions({
      placementQueue: [exit, entry],
      entryQuotes: [entry],
      response: undefined,
      failReason: "zs-proxy unreachable",
    });
    assert.equal(applied.placementQueue.length, 1);
    assert.equal(applied.placementQueue[0]!.source, "inventory_exit");
    assert.match(applied.actions[0]!.message, /dropped/);
  });

  it("approves two-sided reward entry", () => {
    const entry = quote({ side: "bid", outcome: "YES", source: "reward" });
    const id = entryReviewId(entry, 0);
    const applied = applyPlanReviewDecisions({
      placementQueue: [entry],
      entryQuotes: [entry],
      response: {
        decisions: [{ id, action: "approve", reasons: [] }],
      },
    });
    assert.equal(applied.placementQueue.length, 1);
    assert.match(applied.actions[0]!.message, /approved/);
  });

  it("rejects one-sided entry", () => {
    const entry = quote({ side: "bid", outcome: "YES", source: "spread" });
    const id = entryReviewId(entry, 0);
    const applied = applyPlanReviewDecisions({
      placementQueue: [entry],
      entryQuotes: [entry],
      response: {
        decisions: [{ id, action: "reject", reasons: ["one_sided_entry"] }],
      },
    });
    assert.equal(applied.placementQueue.length, 0);
    assert.match(applied.actions[0]!.message, /one_sided_entry/);
  });

  it("shrinks notional when requested", () => {
    const entry = quote({
      side: "bid",
      outcome: "YES",
      source: "reward",
      price: 0.5,
      sizeShares: 20,
    });
    const id = entryReviewId(entry, 0);
    const applied = applyPlanReviewDecisions({
      placementQueue: [entry],
      entryQuotes: [entry],
      response: {
        decisions: [{ id, action: "shrink", maxNotionalUsd: 2, reasons: ["thin_book"] }],
      },
    });
    assert.equal(applied.placementQueue.length, 1);
    assert.ok(applied.placementQueue[0]!.notionalUsd <= 2 + 1e-9);
    assert.match(applied.actions[0]!.message, /shrunk/);
  });

  it("rejects when shrink lacks maxNotionalUsd", () => {
    const entry = quote({ side: "bid", outcome: "YES", source: "reward" });
    const id = entryReviewId(entry, 0);
    const applied = applyPlanReviewDecisions({
      placementQueue: [entry],
      entryQuotes: [entry],
      response: {
        decisions: [{ id, action: "shrink", reasons: ["thin_book"] }],
      },
    });
    assert.equal(applied.placementQueue.length, 0);
    assert.match(applied.actions[0]!.message, /missing maxNotionalUsd/);
  });

  it("rejects incomplete_data without inventing a shrink size", () => {
    const entry = quote({ side: "bid", outcome: "YES", source: "reward" });
    const id = entryReviewId(entry, 0);
    const applied = applyPlanReviewDecisions({
      placementQueue: [entry],
      entryQuotes: [entry],
      response: {
        decisions: [{ id, action: "reject", reasons: ["incomplete_data"] }],
      },
    });
    assert.equal(applied.placementQueue.length, 0);
    assert.match(applied.actions[0]!.message, /incomplete_data/);
  });

  it("rejects entry with missing decision", () => {
    const entry = quote({ side: "bid", outcome: "YES", source: "reward" });
    const applied = applyPlanReviewDecisions({
      placementQueue: [entry],
      entryQuotes: [entry],
      response: {
        decisions: [{ id: "other-id", action: "approve", reasons: [] }],
      },
    });
    assert.equal(applied.placementQueue.length, 0);
    assert.match(applied.actions[0]!.message, /missing decision/);
  });
});

describe("planReview runPlanReview", () => {
  it("skips inference when no entry quotes", async () => {
    const exit = quote({ side: "ask", outcome: "YES", source: "inventory_exit" });
    const exitsOnly = await runPlanReview({
      placementQueue: [exit],
      state: emptyAlphaState(100),
      orderbooks: new Map(),
      markets: new Map(),
      config: testConfig(),
    });
    assert.equal(exitsOnly.reviewed, false);
    assert.equal(exitsOnly.placementQueue.length, 1);
  });

  it("approves via mocked Responses client", async () => {
    const entry = quote({ side: "bid", outcome: "YES", source: "reward" });
    const id = entryReviewId(entry, 0);
    const client: ResponsesClient = {
      responses: {
        async create() {
          return {
            data: messageResponse(
              JSON.stringify({
                decisions: [{ id, action: "approve", reasons: [] }],
              }),
            ),
            headers: new Headers({ "X-Zs-Inference-Amount": "0.001" }),
          };
        },
      },
    };

    const result = await runPlanReview({
      placementQueue: [entry],
      state: emptyAlphaState(100),
      orderbooks: new Map([[APP_ID, twoSidedBook()]]),
      markets: new Map([[APP_ID, market()]]),
      config: testConfig(),
      responsesClient: client,
      skipHealthCheck: true,
      model: "test-model",
      reasoningEffort: "low",
      operatorPreferences: "",
    });

    assert.equal(result.reviewed, true);
    assert.equal(result.placementQueue.length, 1);
    assert.match(result.inferenceCostLine ?? "", /0\.001/);
  });

  it("fail-closes entries on malformed JSON after repair", async () => {
    const entry = quote({ side: "bid", outcome: "YES", source: "reward" });
    const exit = quote({
      side: "ask",
      outcome: "NO",
      source: "inventory_exit",
      price: 0.6,
      sizeShares: 3,
    });
    let calls = 0;
    const client: ResponsesClient = {
      responses: {
        async create() {
          calls += 1;
          return { data: messageResponse("not json at all") };
        },
      },
    };

    const result = await runPlanReview({
      placementQueue: [exit, entry],
      state: emptyAlphaState(100),
      orderbooks: new Map([[APP_ID, twoSidedBook()]]),
      markets: new Map([[APP_ID, market()]]),
      config: testConfig(),
      responsesClient: client,
      skipHealthCheck: true,
      model: "test-model",
      reasoningEffort: "low",
      operatorPreferences: "",
    });

    assert.equal(calls, 2); // initial + repair
    assert.equal(result.placementQueue.length, 1);
    assert.equal(result.placementQueue[0]!.source, "inventory_exit");
    assert.ok(result.actions.some((action) => /dropped|failed|parse/i.test(action.message)));
  });

  it("repairs invalid first reply then applies decision", async () => {
    const entry = quote({ side: "bid", outcome: "YES", source: "spread" });
    const id = entryReviewId(entry, 0);
    let calls = 0;
    const client: ResponsesClient = {
      responses: {
        async create() {
          calls += 1;
          if (calls === 1) {
            return { data: messageResponse("here is my plan: nope") };
          }
          return {
            data: messageResponse(
              JSON.stringify({
                decisions: [{ id, action: "reject", reasons: ["thin_book"] }],
              }),
            ),
          };
        },
      },
    };

    const result = await runPlanReview({
      placementQueue: [entry],
      state: emptyAlphaState(100),
      orderbooks: new Map([[APP_ID, twoSidedBook()]]),
      markets: new Map([[APP_ID, market()]]),
      config: testConfig(),
      responsesClient: client,
      skipHealthCheck: true,
      model: "test-model",
      reasoningEffort: "low",
      operatorPreferences: "",
    });

    assert.equal(calls, 2);
    assert.equal(result.placementQueue.length, 0);
    assert.ok(result.actions.some((action) => /thin_book/.test(action.message)));
  });

  it("appends OPERATOR PREFERENCES into model instructions", async () => {
    const entry = quote({ side: "bid", outcome: "YES", source: "reward" });
    const id = entryReviewId(entry, 0);
    let capturedInstructions: string | undefined;
    const client: ResponsesClient = {
      responses: {
        async create(request) {
          const body = request as { instructions?: string };
          capturedInstructions =
            typeof body.instructions === "string" ? body.instructions : undefined;
          return {
            data: messageResponse(
              JSON.stringify({
                decisions: [{ id, action: "approve", reasons: [] }],
              }),
            ),
          };
        },
      },
    };

    await runPlanReview({
      placementQueue: [entry],
      state: emptyAlphaState(100),
      orderbooks: new Map([[APP_ID, twoSidedBook()]]),
      markets: new Map([[APP_ID, market()]]),
      config: testConfig(),
      responsesClient: client,
      skipHealthCheck: true,
      model: "test-model",
      reasoningEffort: "low",
      operatorPreferences: "Prioritise reward-lane entries over spread when both look sound.",
    });

    assert.match(capturedInstructions ?? "", /OPERATOR PREFERENCES/);
    assert.match(capturedInstructions ?? "", /Prioritise reward-lane entries/);
    assert.match(capturedInstructions ?? "", /You are Ghillie's plan reviewer/);
    assert.match(capturedInstructions ?? "", /This is not financial advice/);
    assert.match(capturedInstructions ?? "", /Never invent a size/);
  });

  it("sends tools-off host payload with no mnemonic, paymentSignature, or execution tools", async () => {
    const entry = quote({
      side: "bid",
      outcome: "YES",
      source: "reward",
      reason: "Amarok suggested quote",
    });
    const id = entryReviewId(entry, 0);
    let captured: Record<string, unknown> | undefined;
    const client: ResponsesClient = {
      responses: {
        async create(request) {
          captured = request as Record<string, unknown>;
          return {
            data: messageResponse(
              JSON.stringify({
                decisions: [{ id, action: "approve", reasons: [] }],
              }),
            ),
          };
        },
      },
    };

    await runPlanReview({
      placementQueue: [entry],
      state: emptyAlphaState(100),
      orderbooks: new Map([[APP_ID, twoSidedBook()]]),
      markets: new Map([
        [
          APP_ID,
          market(APP_ID, {
            endTs: 1_800_000_000,
            closeTime: "2027-01-01T00:00:00.000Z",
          }),
        ],
      ]),
      config: testConfig(),
      responsesClient: client,
      skipHealthCheck: true,
      model: "test-model",
      reasoningEffort: "low",
      operatorPreferences: "",
    });

    assert.ok(captured);
    const serialized = JSON.stringify(captured);
    assert.equal(captured.tools, undefined);
    assert.doesNotMatch(serialized, /mnemonic/i);
    assert.doesNotMatch(serialized, /paymentSignature/);
    assert.doesNotMatch(serialized, /amarok_get_execution_quote/);
    assert.equal(captured.store, false);
  });
});
