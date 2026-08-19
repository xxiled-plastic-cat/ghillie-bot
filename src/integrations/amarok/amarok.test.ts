import assert from "node:assert/strict";
import test from "node:test";

import algosdk from "algosdk";
import {
  parseExecutionQuotePayload,
  regroupUnsignedTransactions,
} from "../algorand/submitUnsigned.js";
import { scanFromAmarok } from "./adapters.js";
import { parseToolPayload } from "./client.js";
import { AlgorandPaymentBuilder, encodePaymentNote } from "./payment.js";
import { walletFromMnemonic } from "./wallet.js";

const network = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";

const fixedSuggestedParams = {
  fee: 1_000n,
  flatFee: false,
  firstValid: 1_000n,
  lastValid: 2_000n,
  genesisID: "mainnet-v1.0",
  genesisHash: new Uint8Array(32).fill(1),
  minFee: 1_000n,
} as algosdk.SuggestedParams;

function builder() {
  const walletAccount = algosdk.generateAccount();
  const wallet = walletFromMnemonic(algosdk.secretKeyToMnemonic(walletAccount.sk));
  return new AlgorandPaymentBuilder(wallet, {
    algodUrl: "https://mainnet-api.algonode.cloud",
    getSuggestedParams: async () => fixedSuggestedParams,
  });
}

function paymentRequest(amount: string, path = "/v1/alpha/opportunities") {
  return {
    x402Version: 2,
    resource: {
      url: `https://amarok-api.compx.io${path}`,
    },
    accepts: [
      {
        scheme: "exact" as const,
        network,
        asset: "31566704",
        amount,
        payTo: algosdk.generateAccount().addr.toString(),
      },
    ],
  };
}

test("rejects payment above Amarok endpoint ceiling", async () => {
  await assert.rejects(() => builder().build(paymentRequest("50001")), /endpoint ceiling/);
  await assert.rejects(
    () => builder().build(paymentRequest("250001", "/v1/alpha/scan")),
    /endpoint ceiling/,
  );
  await assert.rejects(
    () => builder().build(paymentRequest("50001", "/v1/alpha/rewards")),
    /endpoint ceiling/,
  );
  await assert.rejects(
    () => builder().build(paymentRequest("50001", "/v1/alpha/spreads")),
    /endpoint ceiling/,
  );
  await assert.rejects(
    () => builder().build(paymentRequest("50001", "/v1/alpha/parity")),
    /endpoint ceiling/,
  );
});

test("rejects unexpected resource origin", async () => {
  const request = paymentRequest("50000");
  request.resource.url = "https://attacker.example/v1/alpha/opportunities";
  await assert.rejects(() => builder().build(request), /Unexpected x402 resource origin/);
});

test("builds payment signature for opportunities path", async () => {
  const built = await builder().build(paymentRequest("50000"));
  assert.ok(built.paymentSignature.length > 20);
  assert.equal(built.receipt.resourcePath, "/v1/alpha/opportunities");
  assert.equal(built.receipt.amountBaseUnits, "50000");
});

test("builds payment signature for lane-ranking paths", async () => {
  for (const path of ["/v1/alpha/rewards", "/v1/alpha/spreads", "/v1/alpha/parity"]) {
    const built = await builder().build(paymentRequest("50000", path));
    assert.ok(built.paymentSignature.length > 20);
    assert.equal(built.receipt.resourcePath, path);
    assert.equal(built.receipt.amountBaseUnits, "50000");
  }
});

test("encodePaymentNote includes path and nonce", () => {
  const note = new TextDecoder().decode(encodePaymentNote("/v1/alpha/quotes", "abc"));
  assert.match(note, /x402-payment-v2\|\/v1\/alpha\/quotes\|abc/);
});

test("parseToolPayload reads MCP text JSON", () => {
  const payload = parseToolPayload({
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: "PAYMENT_REQUIRED", mcpPayment: { paymentRequired: {} } }),
      },
    ],
  });
  assert.equal((payload as { error: string }).error, "PAYMENT_REQUIRED");
});

test("parseExecutionQuotePayload requires unsigned txns and executionSubmitted false", () => {
  const parsed = parseExecutionQuotePayload({
    data: {
      shape: "alpha_place_limit_order",
      unsignedTxnsBase64: ["AAAA"],
      meta: { executionSubmitted: false },
    },
    meta: { executionSubmitted: false },
  });
  assert.deepEqual(parsed.unsignedTxnsBase64, ["AAAA"]);
});

test("parseExecutionQuotePayload reads nested group.unsignedTxnsBase64 (live Amarok shape)", () => {
  const parsed = parseExecutionQuotePayload({
    meta: { executionSubmitted: false },
    data: [
      {
        shapeKey: "alpha_place_limit_order",
        shapeVersion: 1,
        group: {
          txnCount: 2,
          createEscrowIndex: 1,
          unsignedTxnsBase64: ["qqqq", "wwww"],
        },
      },
    ],
  });
  assert.deepEqual(parsed.unsignedTxnsBase64, ["qqqq", "wwww"]);
  assert.equal(parsed.createEscrowIndex, 1);
});

test("extractCreatedAppId finds inner application-index (bigint-safe)", async () => {
  const { extractCreatedAppId } = await import("../algorand/submitUnsigned.js");
  assert.equal(
    extractCreatedAppId({
      "confirmed-round": 63852138n,
      "inner-txns": [{ "application-index": 3666534173n }],
    }),
    3666534173,
  );
  assert.equal(
    extractCreatedAppId({
      txn: { type: "pay" },
      "confirmed-round": 1,
    }),
    undefined,
  );
  assert.equal(extractCreatedAppId({ applicationIndex: 42 }), 42);
});

test("regroupUnsignedTransactions repairs mismatched Amarok group digests", () => {
  const account = algosdk.generateAccount();
  const params = { ...fixedSuggestedParams, flatFee: true, fee: 1_000n };
  const a = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: account.addr,
    amount: 1,
    suggestedParams: params,
  });
  const b = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: account.addr,
    amount: 2,
    suggestedParams: params,
  });
  const [correctA, correctB] = algosdk.assignGroupID([a, b]);
  const correctGroup = Buffer.from(correctA.group!);

  // Simulate Amarok baking a wrong group id onto otherwise-valid unsigned txns.
  const wrongGroup = new Uint8Array(32).fill(7);
  correctA.group = wrongGroup;
  correctB.group = wrongGroup;
  const encoded = [correctA, correctB].map((txn) =>
    Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString("base64"),
  );

  const repaired = regroupUnsignedTransactions(encoded);
  assert.equal(repaired.length, 2);
  assert.ok(repaired[0].group);
  assert.ok(Buffer.from(repaired[0].group!).equals(correctGroup));
  assert.ok(Buffer.from(repaired[1].group!).equals(correctGroup));
});

test("scanFromAmarok adapts markets and books", () => {
  const scan = scanFromAmarok({
    scanPayload: {
      data: {
        markets: [
          {
            marketAppId: 3100000001,
            slug: "sample",
            title: "Sample",
            status: "live",
            resolved: false,
            book: { bestBid: 0.42, bestAsk: 0.44, mid: 0.43 },
            reward: { isRewardMarket: true, dailyRewardsUsd: 12 },
          },
        ],
      },
    },
    opportunitiesPayload: {
      data: [
        { kind: "lp_reward", marketAppId: 3100000001, title: "Sample", estimatedUsdPerDay: "12.4" },
      ],
    },
  });
  assert.equal(scan.markets.length, 1);
  assert.equal(scan.rewardMarkets.length, 1);
  const book = scan.orderbooks.get(3100000001);
  assert.ok(book?.yesBid === 0.42);
  assert.ok((book?.yesSideOrders.bids.length ?? 0) > 0);
  assert.ok((book?.yesSideOrders.asks.length ?? 0) > 0);
  assert.ok((book?.yesSideOrders.bids[0]?.price ?? 0) === 0.42);
  assert.ok((book?.yesSideOrders.asks[0]?.price ?? 0) === 0.44);
});

test("scanFromAmarok fills rewardMarkets from rewardsPayload without opportunities", () => {
  const scan = scanFromAmarok({
    scanPayload: {
      data: {
        markets: [
          {
            marketAppId: 3100000002,
            title: "Reward lane",
            status: "live",
            resolved: false,
            book: { bestBid: 0.4, bestAsk: 0.45 },
          },
        ],
      },
    },
    rewardsPayload: {
      data: [{ marketAppId: 3100000002, title: "Reward lane", estimatedUsdPerDay: "8.5" }],
    },
  });
  assert.equal(scan.rewardMarkets.length, 1);
  assert.equal(scan.rewardMarkets[0]?.marketAppId, 3100000002);
  assert.equal(scan.rewardMarkets[0]?.reward.dailyRewardsUsd, 8.5);
});

test("scanFromAmarok attaches suggested quotes to scan and reward markets", () => {
  const scan = scanFromAmarok({
    scanPayload: {
      data: {
        markets: [
          {
            marketAppId: 3100000003,
            title: "Quoted",
            status: "live",
            resolved: false,
            book: { bestBid: 0.4, bestAsk: 0.45, mid: 0.425 },
            reward: { isRewardMarket: true, dailyRewardsUsd: 4 },
          },
        ],
      },
    },
    rewardsPayload: {
      data: [{ marketAppId: 3100000003, title: "Quoted", estimatedUsdPerDay: "4" }],
    },
    quotesPayload: {
      data: [
        {
          marketAppId: 3100000003,
          outcome: "YES",
          side: "bid",
          price: 0.41,
          sizeShares: 7,
          kind: "lp_reward",
          reason: "Amarok suggested quote",
        },
      ],
    },
  });
  const scanMarket = scan.markets.find((market) => market.marketAppId === 3100000003);
  const rewardMarket = scan.rewardMarkets.find((market) => market.marketAppId === 3100000003);
  assert.equal(scanMarket?.suggestedQuotes?.length, 1);
  assert.equal(rewardMarket?.suggestedQuotes?.length, 1);
  assert.equal(scanMarket?.suggestedQuotes?.[0]?.price, 0.41);
  assert.equal(scanMarket?.suggestedQuotes?.[0]?.source, "reward");
  assert.equal(
    (scanMarket?.raw as { amarokQuotes?: unknown[] } | undefined)?.amarokQuotes?.length,
    1,
  );
});
