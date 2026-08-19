import {
  buildCancelOrderTxn,
  buildPlaceOrderTxns,
  DIR_BUY,
  Div3rsaFiClient,
  getNextOrderId,
  SIDE_NO,
  SIDE_YES,
} from "@div3rsafi/sdk";
import algosdk from "algosdk";

import type {
  ActiveTargetState,
  BotState,
  ExecutionConfig,
  ExecutionResult,
  RequoteDecision,
  TopTarget,
} from "../types/execution.js";

type BotAccount = {
  address: string;
  account: algosdk.Account;
};

function loadAccount(config: ExecutionConfig): BotAccount {
  const mnemonic = (config.payerMnemonic ?? "").trim();
  if (!mnemonic) {
    throw new Error("PAYER_MNEMONIC is required in live execution mode");
  }
  try {
    const account = algosdk.mnemonicToSecretKey(mnemonic);
    return { account, address: account.addr.toString() };
  } catch {
    throw new Error("PAYER_MNEMONIC is not a valid Algorand mnemonic");
  }
}

function toActiveTargetState(
  target: TopTarget,
  orderIds: string[],
  mode: ExecutionConfig["executionMode"],
): ActiveTargetState {
  const now = new Date().toISOString();
  return {
    mode,
    marketId: target.marketId,
    strikeIndex: target.strikeIndex,
    strikeCents: target.strikeCents,
    underlying: target.underlying,
    timeframe: target.timeframe,
    yesBuyPriceCents: target.yesBuyPriceCents,
    noBuyPriceCents: target.noBuyPriceCents,
    targetScore: target.targetScore,
    orderIds,
    placedAt: now,
    lastSeenAt: now,
  };
}

function validateLiveEnabled(config: ExecutionConfig): void {
  if (config.executionMode !== "live") return;
  if (!config.enableLiveTrading) {
    throw new Error("live mode requested but ENABLE_LIVE_TRADING is not true");
  }
}

function preflightTarget(target: TopTarget, config: ExecutionConfig): void {
  for (const price of [target.yesBuyPriceCents, target.noBuyPriceCents]) {
    if (price < config.minPriceCents || price > config.maxPriceCents) {
      throw new Error(`quote price ${price}c outside configured bounds`);
    }
    if (price < 1 || price > 99) {
      throw new Error(`quote price ${price}c outside protocol bounds`);
    }
  }
  if (target.yesBuyPriceCents + target.noBuyPriceCents >= 100) {
    throw new Error("YES BUY + NO BUY would cross parity");
  }
  if (target.quantity <= 0) {
    throw new Error("ORDER_QUANTITY must be positive");
  }
}

async function cancelOwnOpenOrders(
  api: Div3rsaFiClient,
  algod: algosdk.Algodv2,
  bot: BotAccount,
  target: Pick<TopTarget, "marketId" | "strikeIndex">,
): Promise<string[]> {
  const book = await api.getOrderBook(target.marketId, target.strikeIndex);
  const myOrders: Array<{ order_id: number }> = [];
  for (const levels of [book.yes_buys, book.yes_sells, book.no_buys, book.no_sells]) {
    for (const order of levels) {
      if (order.owner === bot.address) myOrders.push(order);
    }
  }

  const cancelled: string[] = [];
  for (const order of myOrders) {
    try {
      const params = await algod.getTransactionParams().do();
      const [txn] = buildCancelOrderTxn({
        sender: bot.address,
        orderId: order.order_id,
        suggestedParams: params,
      });
      const signed = txn.signTxn(bot.account.sk);
      const res = await algod.sendRawTransaction([signed]).do();
      await algosdk.waitForConfirmation(algod, res.txid, 15);
      cancelled.push(String(order.order_id));
    } catch {
      // Already matched/cancelled between book fetch and cancel is acceptable.
    }
  }
  return cancelled;
}

async function placeBuyQuote(
  algod: algosdk.Algodv2,
  bot: BotAccount,
  target: TopTarget,
  side: 0 | 1,
  price: number,
): Promise<string> {
  const [suggestedParams, nextOrderId] = await Promise.all([
    algod.getTransactionParams().do(),
    getNextOrderId(algod),
  ]);
  const group = buildPlaceOrderTxns({
    sender: bot.address,
    marketId: target.marketId,
    strike: target.strikeCents,
    side,
    direction: DIR_BUY,
    price,
    quantity: target.quantity,
    haltTimestamp: target.haltTs,
    nextOrderId,
    suggestedParams,
  });
  const signed = group.map((txn) => txn.signTxn(bot.account.sk));
  const res = await algod.sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(algod, res.txid, 15);
  return nextOrderId.toString();
}

export async function executeDecision(
  state: BotState,
  decision: RequoteDecision,
  config: ExecutionConfig,
): Promise<{ state: BotState; result: ExecutionResult }> {
  if (decision.action === "skip") {
    return {
      state,
      result: {
        mode: config.executionMode,
        action: "skipped",
        reason: decision.reason,
        activeOrderIds: state.activeTarget?.orderIds ?? [],
      },
    };
  }

  if (decision.action === "hold") {
    if (state.activeTarget) {
      state.activeTarget.lastSeenAt = new Date().toISOString();
    }
    return {
      state,
      result: {
        mode: config.executionMode,
        action: "held",
        reason: decision.reason,
        activeOrderIds: state.activeTarget?.orderIds ?? [],
      },
    };
  }

  validateLiveEnabled(config);
  preflightTarget(decision.topTarget, config);

  if (config.executionMode === "paper") {
    const paperOrderIds = [`paper-yes-${Date.now()}`, `paper-no-${Date.now()}`];
    const previousKey = state.activeTarget
      ? `${state.activeTarget.marketId}:${state.activeTarget.strikeIndex}`
      : undefined;
    state.activeTarget = toActiveTargetState(decision.topTarget, paperOrderIds, "paper");
    state.moveHistory.push({
      mode: "paper",
      movedAt: new Date().toISOString(),
      from: previousKey,
      to: `${decision.topTarget.marketId}:${decision.topTarget.strikeIndex}`,
      reason: decision.reason,
    });
    return {
      state,
      result: {
        mode: "paper",
        action: "moved",
        reason: decision.reason,
        activeOrderIds: paperOrderIds,
      },
    };
  }

  const bot = loadAccount(config);
  const api = new Div3rsaFiClient();
  const algod = new algosdk.Algodv2(config.algodToken ?? "", config.algodUrl, "");

  if (state.activeTarget) {
    await cancelOwnOpenOrders(api, algod, bot, state.activeTarget);
  }
  await cancelOwnOpenOrders(api, algod, bot, decision.topTarget);

  const yesOrderId = await placeBuyQuote(
    algod,
    bot,
    decision.topTarget,
    SIDE_YES,
    decision.topTarget.yesBuyPriceCents,
  );
  const noOrderId = await placeBuyQuote(
    algod,
    bot,
    decision.topTarget,
    SIDE_NO,
    decision.topTarget.noBuyPriceCents,
  );
  const previousKey = state.activeTarget
    ? `${state.activeTarget.marketId}:${state.activeTarget.strikeIndex}`
    : undefined;
  state.activeTarget = toActiveTargetState(decision.topTarget, [yesOrderId, noOrderId], "live");
  state.moveHistory.push({
    mode: "live",
    movedAt: new Date().toISOString(),
    from: previousKey,
    to: `${decision.topTarget.marketId}:${decision.topTarget.strikeIndex}`,
    reason: decision.reason,
  });

  return {
    state,
    result: {
      mode: "live",
      action: "moved",
      reason: decision.reason,
      activeOrderIds: [yesOrderId, noOrderId],
    },
  };
}
