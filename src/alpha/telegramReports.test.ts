import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { emptyAlphaState } from "./alphaStateStore.js";
import {
  escapeHtml,
  escapeRichMarkdown,
  notifyTelegramReport,
} from "./telegramNotifier.js";
import {
  extractInferenceCostLine,
  formatDailySummaryReport,
  formatTickDigestReport,
  summarizeTickActions,
} from "./telegramReports.js";

describe("telegramReports", () => {
  it("formats rich tick digest with headings, accountancy, and spend", () => {
    const state = emptyAlphaState(100);
    state.realisedPnl = 2.5;
    state.unrealisedPnl = -0.5;
    state.totalPnl = 2;
    state.strategyStats.spreadRealisedPnl = 1.25;
    state.strategyStats.liveOrdersPlaced = 3;

    const report = formatTickDigestReport({
      state,
      walletUsdcBalanceUsd: 80,
      walletAlgoBalance: 1.5,
      actions: [
        { kind: "place", message: "Placed bid YES @ 0.42 x 10" },
        { kind: "cancel", message: "Cancelled escrow 123" },
        { kind: "skip", message: "ZeroSignal inference: 1 request(s), $0.0042 USDC" },
        { kind: "skip", message: "No live placements; wallet ALGO below safety floor" },
      ],
      spend: {
        payments: [{ amountBaseUnits: "50000" }, { amountBaseUnits: "25000" }],
      },
      at: "2026-08-01T12:00:00.000Z",
    });

    assert.match(report.rich, /### Ghillie tick · 2026-08-01T12:00:00\.000Z/);
    assert.match(report.rich, /\*\*Wallet\*\*/);
    assert.match(report.rich, /### Accountancy/);
    assert.match(report.rich, /Total economic \*\*/);
    assert.match(report.rich, /### Actions/);
    assert.match(report.rich, /\| Kind \| Detail \|/);
    assert.match(report.rich, /### Spend/);
    assert.match(report.rich, /Amarok x402: \*\*2\*\* call\(s\), `75000` USDC base units/);
    assert.match(report.rich, /ZeroSignal inference/);
    assert.match(report.rich, /<details>/);
    assert.match(report.rich, /Warnings/);
  });

  it("escapes HTML metacharacters in action detail", () => {
    const state = emptyAlphaState(50);
    const report = formatTickDigestReport({
      state,
      walletUsdcBalanceUsd: 10,
      actions: [{ kind: "place", message: "Placed <bid> & ask" }],
      at: "2026-08-01T12:00:00.000Z",
    });

    assert.match(report.html, /<b>Ghillie tick/);
    assert.match(report.html, /Placed &lt;bid&gt; &amp; ask/);
    assert.doesNotMatch(report.html, /Placed <bid>/);
  });

  it("formats plain daily summary with wallet and accountancy", () => {
    const state = emptyAlphaState(100);
    state.strategyStats.liveOrdersPlaced = 9;
    state.strategyStats.liveOrdersCancelled = 2;

    const report = formatDailySummaryReport({
      state,
      walletUsdcBalanceUsd: 55.5,
      walletAlgoBalance: 2,
      spend: {
        payments: [{ amountBaseUnits: "100000" }],
        inferenceCostLine: "ZeroSignal inference: 2 request(s), $0.01 USDC",
      },
      at: "2026-08-01",
    });

    assert.match(report.plain, /Ghillie daily · 2026-08-01/);
    assert.match(report.plain, /Wallet: \$55\.50 USDC/);
    assert.match(report.plain, /Trading:/);
    assert.match(report.plain, /Total economic/);
    assert.match(report.plain, /Lifetime: placed=9 cancelled=2/);
    assert.match(report.plain, /Amarok x402: 1 call\(s\), 100000 USDC base units/);
    assert.match(report.rich, /### Ghillie daily/);
    assert.match(report.rich, /### Spend/);
  });

  it("omits Spend section when no payments or inference", () => {
    const report = formatTickDigestReport({
      state: emptyAlphaState(10),
      actions: [{ kind: "skip", message: "Nothing to do" }],
      at: "2026-08-01T00:00:00.000Z",
    });
    assert.doesNotMatch(report.rich, /### Spend/);
    assert.doesNotMatch(report.html, /<b>Spend<\/b>/);
    assert.doesNotMatch(report.plain, /^Spend:/m);
  });

  it("summarizes tick actions and extracts inference cost line", () => {
    const summary = summarizeTickActions([
      { kind: "place", message: "placed" },
      { kind: "cancel", message: "cancelled" },
      { kind: "skip", message: "Live entry fill YES" },
      { kind: "skip", message: "Live exit fill NO" },
      { kind: "merge", message: "merged inventory" },
      { kind: "skip", message: "ZeroSignal inference: 1 request(s), $0.001 USDC" },
      { kind: "skip", message: "No live placements; wallet ALGO below safety floor" },
    ]);
    assert.equal(summary.placed.length, 1);
    assert.equal(summary.cancelled.length, 1);
    assert.equal(summary.inferredEntryFills.length, 1);
    assert.equal(summary.inferredExitFills.length, 1);
    assert.equal(summary.recycleEvents.length, 1);
    assert.equal(summary.warnings.length, 1);
    assert.equal(
      extractInferenceCostLine([
        { kind: "skip", message: "ZeroSignal inference: 1 request(s), $0.001 USDC" },
      ]),
      "ZeroSignal inference: 1 request(s), $0.001 USDC",
    );
  });
});

describe("telegramNotifier helpers", () => {
  it("escapes rich markdown and HTML", () => {
    assert.equal(escapeRichMarkdown("a*b_c"), "a\\*b\\_c");
    assert.equal(escapeHtml("a<b>&c"), "a&lt;b&gt;&amp;c");
  });
});

describe("notifyTelegramReport fallback", () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChat = process.env.TELEGRAM_CHAT_ID;
  const originalDisable = process.env.TELEGRAM_DISABLE_NOTIFICATIONS;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChat;
    if (originalDisable === undefined) delete process.env.TELEGRAM_DISABLE_NOTIFICATIONS;
    else process.env.TELEGRAM_DISABLE_NOTIFICATIONS = originalDisable;
    mock.restoreAll();
  });

  it("falls back from rich to HTML to plain", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "token";
    process.env.TELEGRAM_CHAT_ID = "chat";
    delete process.env.TELEGRAM_DISABLE_NOTIFICATIONS;

    const calls: string[] = [];
    let sendMessageAttempts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("sendRichMessage")) {
        return new Response(JSON.stringify({ ok: false, description: "rich unsupported" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      sendMessageAttempts += 1;
      if (sendMessageAttempts === 1) {
        return new Response(JSON.stringify({ ok: false, description: "html failed" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const sent = await notifyTelegramReport({
      rich: "### rich",
      html: "<b>html</b>",
      plain: "plain",
    });

    assert.equal(sent, true);
    assert.equal(calls.length, 3);
    assert.match(calls[0]!, /sendRichMessage/);
    assert.match(calls[1]!, /sendMessage/);
    assert.match(calls[2]!, /sendMessage/);
  });
});
