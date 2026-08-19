import assert from "node:assert/strict";
import { describe, it } from "node:test";

import algosdk from "algosdk";

import {
  ALPHA_REWARD_HISTORY_SENDER,
  aggregateFlowTotals,
  buildTransferClassificationContext,
  classifyTransfer,
  computeNetWorth,
  totalPositionsValueUsd,
} from "./capitalLedger.js";
import type { WalletUsdcTransfer } from "./indexerTransfers.js";

const WALLET = algosdk.encodeAddress(new Uint8Array(32).fill(1));
const EXTERNAL = algosdk.encodeAddress(new Uint8Array(32).fill(2));
const REWARD_SENDER = ALPHA_REWARD_HISTORY_SENDER;
const MATCHER_APP_ID = 3_078_581_851;
const MARKET_APP_ID = 3_100_000_001;
const ESCROW_APP_ID = 3_100_000_099;

function transfer(
  partial: Partial<WalletUsdcTransfer> & Pick<WalletUsdcTransfer, "direction" | "amountMicroUsdc">,
): WalletUsdcTransfer {
  return {
    sender: WALLET,
    receiver: WALLET,
    ...partial,
  };
}

function testContext() {
  return buildTransferClassificationContext({
    walletAddress: WALLET,
    matcherAppId: MATCHER_APP_ID,
    marketAppIds: [MARKET_APP_ID],
    escrowAppIds: [ESCROW_APP_ID],
  });
}

describe("computeNetWorth", () => {
  it("sums wallet, bid escrow, and position values", () => {
    const netWorth = computeNetWorth(100, 25, [
      { valueUsd: 40 },
      { lockedUsd: 10, valueUsd: undefined },
    ]);
    assert.equal(netWorth, 175);
  });

  it("returns undefined when wallet balance is unknown", () => {
    assert.equal(computeNetWorth(undefined, 25, [{ valueUsd: 10 }]), undefined);
  });
});

describe("totalPositionsValueUsd", () => {
  it("prefers mark value over locked cost", () => {
    assert.equal(totalPositionsValueUsd([{ valueUsd: 12, lockedUsd: 8 }]), 12);
  });

  it("falls back to locked cost when mark is missing", () => {
    assert.equal(totalPositionsValueUsd([{ lockedUsd: 8 }]), 8);
  });
});

describe("classifyTransfer", () => {
  const context = testContext();
  const matcherAddress = algosdk.getApplicationAddress(MATCHER_APP_ID).toString();
  const marketAddress = algosdk.getApplicationAddress(MARKET_APP_ID).toString();
  const escrowAddress = algosdk.getApplicationAddress(ESCROW_APP_ID).toString();

  it("classifies reward inflows", () => {
    const bucket = classifyTransfer(
      transfer({
        direction: "in",
        sender: REWARD_SENDER,
        receiver: WALLET,
        amountMicroUsdc: 1_500_000n,
      }),
      context,
    );
    assert.equal(bucket, "reward");
  });

  it("classifies market inflows and outflows", () => {
    assert.equal(
      classifyTransfer(
        transfer({
          direction: "in",
          sender: marketAddress,
          receiver: WALLET,
          amountMicroUsdc: 2_000_000n,
        }),
        context,
      ),
      "market",
    );
    assert.equal(
      classifyTransfer(
        transfer({
          direction: "out",
          sender: WALLET,
          receiver: escrowAddress,
          amountMicroUsdc: 3_000_000n,
        }),
        context,
      ),
      "market",
    );
    assert.equal(
      classifyTransfer(
        transfer({
          direction: "out",
          sender: WALLET,
          receiver: matcherAddress,
          amountMicroUsdc: 1_000_000n,
        }),
        context,
      ),
      "market",
    );
  });

  it("classifies external capital flows", () => {
    const external = EXTERNAL;
    assert.equal(
      classifyTransfer(
        transfer({
          direction: "in",
          sender: external,
          receiver: WALLET,
          amountMicroUsdc: 206_000_000n,
        }),
        context,
      ),
      "external",
    );
    assert.equal(
      classifyTransfer(
        transfer({
          direction: "out",
          sender: WALLET,
          receiver: external,
          amountMicroUsdc: 5_000_000n,
        }),
        context,
      ),
      "external",
    );
  });
});

describe("aggregateFlowTotals", () => {
  it("accumulates bucket totals in USD", () => {
    const context = testContext();
    const marketAddress = algosdk.getApplicationAddress(MARKET_APP_ID).toString();
    const external = EXTERNAL;
    const totals = aggregateFlowTotals(
      [
        transfer({
          direction: "in",
          sender: REWARD_SENDER,
          receiver: WALLET,
          amountMicroUsdc: 1_000_000n,
        }),
        transfer({
          direction: "in",
          sender: marketAddress,
          receiver: WALLET,
          amountMicroUsdc: 2_500_000n,
        }),
        transfer({
          direction: "out",
          sender: WALLET,
          receiver: marketAddress,
          amountMicroUsdc: 500_000n,
        }),
        transfer({
          direction: "in",
          sender: external,
          receiver: WALLET,
          amountMicroUsdc: 206_000_000n,
        }),
      ],
      context,
    );
    assert.equal(totals.rewardsReceivedUsd, 1);
    assert.equal(totals.marketUsdcInUsd, 2.5);
    assert.equal(totals.marketUsdcOutUsd, 0.5);
    assert.equal(totals.externalInUsd, 206);
    assert.equal(totals.externalOutUsd, 0);
  });
});
