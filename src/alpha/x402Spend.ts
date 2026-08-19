/**
 * Amarok x402 spend visibility (Brownie Canix daily-spend pattern).
 * Counters live on existing Alpha bot-state — no extra store.
 * Visibility only: the payment builder still enforces MAX_DAILY_X402_BASE_UNITS
 * inside a process. Never log mnemonics or paymentSignature.
 */

import type { PaymentReceipt } from "../integrations/amarok/payment.js";
import type { AlphaConfig } from "./alphaConfig.js";
import { loadAlphaState, saveAlphaState } from "./alphaStateStore.js";
import type { AlphaBotState } from "./alphaTypes.js";

const USDC_DECIMALS = 6;
const USDC_SCALE = 1_000_000n;

export type X402SpendState = {
  utcDate: string;
  spentBaseUnits: string;
  callCount: number;
  lastRunBaseUnits: string;
  lastRunCallCount: number;
  updatedAt: string;
};

export type X402SpendLane = {
  usedUsdc: string;
  capUsdc: string | null;
  remainingUsdc: string | null;
  uncapped: boolean;
  callCount: number;
};

export type X402LastRunSpend = {
  callCount: number;
  usedUsdc: string;
  usedBaseUnits: string;
};

export type X402SpendReport = {
  dayUtc: string;
  timezone: "UTC";
  amarok: X402SpendLane;
  lastRun?: X402LastRunSpend;
};

export type X402PaymentInput = Pick<PaymentReceipt, "amountBaseUnits">;

/** UTC calendar day `YYYY-MM-DD` (same convention as the x402 payment builder). */
export function utcDayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function formatUsdcFromBaseUnits(amount: bigint): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = abs / USDC_SCALE;
  const fraction = (abs % USDC_SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  const body = fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
  return negative ? `-${body}` : body;
}

export function parseBaseUnits(value: unknown): bigint {
  if (typeof value === "bigint") return value >= 0n ? value : 0n;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return BigInt(Math.floor(value));
  }
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return 0n;
  return BigInt(value);
}

export function sumPaymentBaseUnits(payments: readonly X402PaymentInput[] | undefined): bigint {
  if (!payments || payments.length === 0) return 0n;
  let total = 0n;
  for (const payment of payments) {
    total += parseBaseUnits(payment.amountBaseUnits);
  }
  return total;
}

export function normalizeX402Spend(
  raw: unknown,
  now: Date = new Date(),
): X402SpendState | undefined {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const utcDate =
    typeof record.utcDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(record.utcDate)
      ? record.utcDate.slice(0, 10)
      : utcDayKey(now);
  const callCount =
    typeof record.callCount === "number" &&
    Number.isFinite(record.callCount) &&
    record.callCount >= 0
      ? Math.floor(record.callCount)
      : 0;
  const lastRunCallCount =
    typeof record.lastRunCallCount === "number" &&
    Number.isFinite(record.lastRunCallCount) &&
    record.lastRunCallCount >= 0
      ? Math.floor(record.lastRunCallCount)
      : 0;
  return rolloverX402Spend(
    {
      utcDate,
      spentBaseUnits: parseBaseUnits(record.spentBaseUnits).toString(),
      callCount,
      lastRunBaseUnits: parseBaseUnits(record.lastRunBaseUnits).toString(),
      lastRunCallCount,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now.toISOString(),
    },
    now,
  );
}

export function rolloverX402Spend(
  spend: X402SpendState | undefined,
  now: Date = new Date(),
): X402SpendState {
  const today = utcDayKey(now);
  if (spend && spend.utcDate === today) return spend;
  return {
    utcDate: today,
    spentBaseUnits: "0",
    callCount: 0,
    lastRunBaseUnits: "0",
    lastRunCallCount: 0,
    updatedAt: now.toISOString(),
  };
}

export function applyX402Payments(
  spend: X402SpendState | undefined,
  payments: readonly X402PaymentInput[] | undefined,
  now: Date = new Date(),
): X402SpendState {
  const current = normalizeX402Spend(spend, now) ?? rolloverX402Spend(undefined, now);
  const runBaseUnits = sumPaymentBaseUnits(payments);
  const runCalls = payments?.length ?? 0;
  if (runCalls === 0 && runBaseUnits === 0n) return current;
  return {
    utcDate: current.utcDate,
    spentBaseUnits: (parseBaseUnits(current.spentBaseUnits) + runBaseUnits).toString(),
    callCount: current.callCount + runCalls,
    lastRunBaseUnits: runBaseUnits.toString(),
    lastRunCallCount: runCalls,
    updatedAt: now.toISOString(),
  };
}

export function applyX402PaymentsToState(
  state: AlphaBotState,
  payments: readonly X402PaymentInput[] | undefined,
  now: Date = new Date(),
): X402SpendState {
  const next = applyX402Payments(state.x402Spend, payments, now);
  state.x402Spend = next;
  return next;
}

function normalizeCapBaseUnits(value: bigint | null | undefined): bigint | null {
  if (value === undefined || value === null || value <= 0n) return null;
  return value;
}

export function toX402SpendLane(
  spentBaseUnits: bigint,
  callCount: number,
  capBaseUnits: bigint | null | undefined,
): X402SpendLane {
  const cap = normalizeCapBaseUnits(capBaseUnits);
  const usedUsdc = formatUsdcFromBaseUnits(spentBaseUnits);
  if (cap === null) {
    return {
      usedUsdc,
      capUsdc: null,
      remainingUsdc: null,
      uncapped: true,
      callCount,
    };
  }
  const remaining = cap - spentBaseUnits;
  return {
    usedUsdc,
    capUsdc: formatUsdcFromBaseUnits(cap),
    remainingUsdc: formatUsdcFromBaseUnits(remaining < 0n ? 0n : remaining),
    uncapped: false,
    callCount,
  };
}

export function toX402SpendReport(
  spend: X402SpendState | undefined,
  capBaseUnits: bigint | null | undefined,
  now: Date = new Date(),
): X402SpendReport {
  const current = normalizeX402Spend(spend, now) ?? rolloverX402Spend(undefined, now);
  const spent = parseBaseUnits(current.spentBaseUnits);
  const lastRunCalls = current.lastRunCallCount;
  const lastRunBase = parseBaseUnits(current.lastRunBaseUnits);
  return {
    dayUtc: current.utcDate,
    timezone: "UTC",
    amarok: toX402SpendLane(spent, current.callCount, capBaseUnits),
    lastRun:
      lastRunCalls > 0
        ? {
            callCount: lastRunCalls,
            usedUsdc: formatUsdcFromBaseUnits(lastRunBase),
            usedBaseUnits: lastRunBase.toString(),
          }
        : undefined,
  };
}

export function formatAmarokX402ThisRunLine(
  callCount: number,
  amountBaseUnits: bigint,
  style: "plain" | "rich" | "html" = "plain",
): string {
  const usdc = formatUsdcFromBaseUnits(amountBaseUnits);
  if (style === "rich") {
    return `Amarok x402: **${callCount}** call(s), \`$${usdc}\` USDC`;
  }
  if (style === "html") {
    return `Amarok x402: <b>${callCount}</b> call(s), <code>$${usdc}</code> USDC`;
  }
  return `Amarok x402: ${callCount} call(s), $${usdc} USDC`;
}

export function formatAmarokX402DailyLine(
  lane: X402SpendLane,
  style: "plain" | "rich" | "html" = "plain",
): string {
  const remaining =
    lane.uncapped || lane.remainingUsdc === null ? "uncapped" : `$${lane.remainingUsdc} remaining`;
  if (style === "rich") {
    return `Amarok x402 today (UTC): **$${lane.usedUsdc}** used, **${remaining}**`;
  }
  if (style === "html") {
    return `Amarok x402 today (UTC): <b>$${lane.usedUsdc}</b> used, <b>${remaining}</b>`;
  }
  return `Amarok x402 today (UTC): $${lane.usedUsdc} used, ${remaining}`;
}

export function formatAmarokX402LastRunLine(lastRun: X402LastRunSpend): string {
  return `Amarok x402 last run: ${lastRun.callCount} call(s), $${lastRun.usedUsdc} USDC`;
}

/** Status / health copy — daily used + remaining, plus last run when present. */
export function formatDailySpendLines(report: X402SpendReport): string[] {
  const lines = [formatAmarokX402DailyLine(report.amarok, "plain")];
  if (report.lastRun) {
    lines.push(formatAmarokX402LastRunLine(report.lastRun));
  }
  return lines;
}

export async function persistX402SpendCounters(
  config: Pick<AlphaConfig, "stateKey" | "paperStartingBalanceUsd" | "maxDailyX402BaseUnits">,
  payments: readonly X402PaymentInput[] | undefined,
  now: Date = new Date(),
): Promise<X402SpendReport> {
  const state = await loadAlphaState(config.stateKey, config.paperStartingBalanceUsd);
  applyX402PaymentsToState(state, payments, now);
  await saveAlphaState(config.stateKey, state);
  return toX402SpendReport(state.x402Spend, config.maxDailyX402BaseUnits, now);
}

export async function loadX402SpendReport(
  config: Pick<AlphaConfig, "stateKey" | "paperStartingBalanceUsd" | "maxDailyX402BaseUnits">,
  now: Date = new Date(),
): Promise<X402SpendReport> {
  const state = await loadAlphaState(config.stateKey, config.paperStartingBalanceUsd);
  return toX402SpendReport(state.x402Spend, config.maxDailyX402BaseUnits, now);
}
