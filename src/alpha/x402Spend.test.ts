import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { LocalFilesystemBotStateStore } from "../integrations/storage/botStateStore.js";
import { setAlphaStateStoreForTests } from "./alphaStateStore.js";
import {
  applyX402Payments,
  formatAmarokX402DailyLine,
  formatAmarokX402ThisRunLine,
  formatDailySpendLines,
  formatUsdcFromBaseUnits,
  loadX402SpendReport,
  persistX402SpendCounters,
  toX402SpendReport,
  utcDayKey,
} from "./x402Spend.js";

describe("utcDayKey", () => {
  it("uses the UTC calendar date", () => {
    assert.equal(utcDayKey(new Date("2026-08-14T23:59:59.000Z")), "2026-08-14");
    assert.equal(utcDayKey(new Date("2026-08-15T00:00:00.000Z")), "2026-08-15");
  });
});

describe("formatUsdcFromBaseUnits", () => {
  it("formats micro-USDC without trailing zeros", () => {
    assert.equal(formatUsdcFromBaseUnits(0n), "0");
    assert.equal(formatUsdcFromBaseUnits(50_000n), "0.05");
    assert.equal(formatUsdcFromBaseUnits(75_000n), "0.075");
    assert.equal(formatUsdcFromBaseUnits(5_000_000n), "5");
    assert.equal(formatUsdcFromBaseUnits(1_250_000n), "1.25");
  });
});

describe("applyX402Payments", () => {
  it("rolls over both counters at the UTC day boundary", () => {
    const morning = new Date("2026-08-14T12:00:00.000Z");
    const after = applyX402Payments(undefined, [{ amountBaseUnits: "50000" }], morning);
    assert.equal(after.utcDate, "2026-08-14");
    assert.equal(after.spentBaseUnits, "50000");
    assert.equal(after.callCount, 1);

    const nextDay = applyX402Payments(
      after,
      [{ amountBaseUnits: "25000" }],
      new Date("2026-08-15T00:00:00.000Z"),
    );
    assert.equal(nextDay.utcDate, "2026-08-15");
    assert.equal(nextDay.spentBaseUnits, "25000");
    assert.equal(nextDay.callCount, 1);
    assert.equal(nextDay.lastRunCallCount, 1);
  });

  it("treats a persisted previous UTC day as a fresh zero day", () => {
    const report = toX402SpendReport(
      {
        utcDate: "2026-08-13",
        spentBaseUnits: "999000",
        callCount: 9,
        lastRunBaseUnits: "100000",
        lastRunCallCount: 2,
        updatedAt: "2026-08-13T22:00:00.000Z",
      },
      5_000_000n,
      new Date("2026-08-14T00:00:00.000Z"),
    );
    assert.equal(report.dayUtc, "2026-08-14");
    assert.equal(report.amarok.usedUsdc, "0");
    assert.equal(report.amarok.remainingUsdc, "5");
    assert.equal(report.lastRun, undefined);
  });

  it("shows remaining vs cap and floors at zero when used exceeds cap", () => {
    const spend = applyX402Payments(
      undefined,
      [{ amountBaseUnits: "50000" }, { amountBaseUnits: "25000" }],
      new Date("2026-08-14T12:00:00.000Z"),
    );
    const capped = toX402SpendReport(spend, 5_000_000n, new Date("2026-08-14T12:00:00.000Z"));
    assert.equal(capped.amarok.usedUsdc, "0.075");
    assert.equal(capped.amarok.capUsdc, "5");
    assert.equal(capped.amarok.remainingUsdc, "4.925");
    assert.equal(capped.amarok.uncapped, false);
    assert.equal(capped.lastRun?.callCount, 2);

    const over = applyX402Payments(
      undefined,
      [{ amountBaseUnits: "25" }],
      new Date("2026-08-14T12:00:00.000Z"),
    );
    const exhausted = toX402SpendReport(over, 10n, new Date("2026-08-14T12:00:00.000Z"));
    assert.equal(exhausted.amarok.remainingUsdc, "0");
  });

  it("shows uncapped when the daily cap is zero or omitted", () => {
    const spend = applyX402Payments(
      undefined,
      [{ amountBaseUnits: "1000" }],
      new Date("2026-08-14T12:00:00.000Z"),
    );
    const report = toX402SpendReport(spend, 0n, new Date("2026-08-14T12:00:00.000Z"));
    assert.equal(report.amarok.uncapped, true);
    assert.equal(report.amarok.capUsdc, null);
    assert.equal(report.amarok.remainingUsdc, null);
    assert.equal(
      formatAmarokX402DailyLine(report.amarok),
      "Amarok x402 today (UTC): $0.001 used, uncapped",
    );
  });
});

describe("spend formatter copy", () => {
  it("formats this-run and daily lines without secrets", () => {
    const plain = formatAmarokX402ThisRunLine(2, 75_000n, "plain");
    const rich = formatAmarokX402ThisRunLine(2, 75_000n, "rich");
    const html = formatAmarokX402ThisRunLine(2, 75_000n, "html");
    assert.equal(plain, "Amarok x402: 2 call(s), $0.075 USDC");
    assert.equal(rich, "Amarok x402: **2** call(s), `$0.075` USDC");
    assert.equal(html, "Amarok x402: <b>2</b> call(s), <code>$0.075</code> USDC");
    assert.doesNotMatch(plain, /paymentSignature/);
    assert.doesNotMatch(rich, /mnemonic/i);

    const report = toX402SpendReport(
      applyX402Payments(
        undefined,
        [{ amountBaseUnits: "120000" }],
        new Date("2026-08-14T12:00:00.000Z"),
      ),
      5_000_000n,
      new Date("2026-08-14T12:00:00.000Z"),
    );
    assert.deepEqual(formatDailySpendLines(report), [
      "Amarok x402 today (UTC): $0.12 used, $4.88 remaining",
      "Amarok x402 last run: 1 call(s), $0.12 USDC",
    ]);
  });
});

describe("persistX402SpendCounters", () => {
  let rootDir: string | undefined;

  afterEach(async () => {
    setAlphaStateStoreForTests(undefined);
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it("persists counters on existing bot-state and hydrates them", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "ghillie-x402-spend-"));
    setAlphaStateStoreForTests(
      new LocalFilesystemBotStateStore({ rootDir, prefix: "test-prefix" }),
    );
    const config = {
      stateKey: "alpha",
      paperStartingBalanceUsd: 100,
      maxDailyX402BaseUnits: 5_000_000n,
    };
    const now = new Date("2026-08-14T12:00:00.000Z");
    const first = await persistX402SpendCounters(config, [{ amountBaseUnits: "50000" }], now);
    assert.equal(first.amarok.usedUsdc, "0.05");
    assert.equal(first.amarok.remainingUsdc, "4.95");

    const second = await persistX402SpendCounters(config, [{ amountBaseUnits: "25000" }], now);
    assert.equal(second.amarok.usedUsdc, "0.075");
    assert.equal(second.lastRun?.usedUsdc, "0.025");

    const loaded = await loadX402SpendReport(config, now);
    assert.equal(loaded.amarok.usedUsdc, "0.075");
    assert.equal(loaded.amarok.callCount, 2);
  });
});
