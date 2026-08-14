import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMaySpend,
  isLivePlaceEnabled,
  microUsdcToUsdc,
  opportunityRows,
  pickMarketFromOpportunities,
  redactForLog,
  E2E_EXPECTED_USDC,
} from "./amarokE2eSmoke.js";

test("isLivePlaceEnabled defaults off", () => {
  assert.equal(isLivePlaceEnabled({}), false);
  assert.equal(isLivePlaceEnabled({ GHILLIE_E2E_LIVE: "0" }), false);
  assert.equal(isLivePlaceEnabled({ GHILLIE_E2E_LIVE: "1" }), true);
});

test("assertMaySpend refuses GitHub Actions", () => {
  assert.throws(() => assertMaySpend({ GITHUB_ACTIONS: "true" }), /GitHub Actions/);
  assert.doesNotThrow(() => assertMaySpend({}));
});

test("microUsdcToUsdc formats discovery prices", () => {
  assert.equal(microUsdcToUsdc(5_000), "0.005");
  assert.equal(microUsdcToUsdc(10_000), "0.01");
  assert.equal(microUsdcToUsdc(E2E_EXPECTED_USDC.dryRunTotalMicro), "0.015");
});

test("opportunityRows unwraps nested payloads", () => {
  assert.equal(opportunityRows({ data: [{ marketAppId: 1 }] }).length, 1);
  assert.equal(opportunityRows({ data: { opportunities: [{ marketAppId: 2 }] } }).length, 1);
  assert.equal(opportunityRows([{ marketAppId: 3 }]).length, 1);
});

test("pickMarketFromOpportunities prefers first market and safe defaults", () => {
  const picked = pickMarketFromOpportunities({
    data: [{ marketAppId: 3100000001, title: "Sample", kind: "lp_reward" }],
  });
  assert.equal(picked.marketAppId, 3100000001);
  assert.equal(picked.outcome, "YES");
  assert.equal(picked.side, "bid");
  assert.equal(picked.sizeShares, 1);
  assert.equal(picked.title, "Sample");
});

test("pickMarketFromOpportunities honors --market override", () => {
  const picked = pickMarketFromOpportunities({ data: [] }, { marketAppId: 99, price: 0.3, sizeShares: 1 });
  assert.equal(picked.marketAppId, 99);
  assert.equal(picked.price, 0.3);
});

test("pickMarketFromOpportunities fails closed when empty and no override", () => {
  assert.throws(() => pickMarketFromOpportunities({ data: [] }), /No marketAppId/);
});

test("redactForLog strips mnemonics and payment signatures", () => {
  const redacted = redactForLog({
    walletMnemonic: "word ".repeat(25),
    paymentSignature: "a".repeat(200),
    unsignedTxnsBase64: ["AAAA", "BBBB"],
    ok: true,
  }) as Record<string, unknown>;
  assert.equal(redacted.walletMnemonic, "[redacted]");
  assert.match(String(redacted.paymentSignature), /redacted signature/);
  assert.equal(redacted.unsignedTxnsBase64, "[2 txn(s) omitted]");
  assert.equal(redacted.ok, true);
});
