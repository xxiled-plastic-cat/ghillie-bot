import { resolve } from "node:path";

import type { ExecutionConfig, ExecutionMode } from "../types/execution.js";

function getEnvNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function getEnvBoolean(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw.toLowerCase() === "true" || raw === "1" || raw.toLowerCase() === "yes";
}

function getExecutionMode(): ExecutionMode {
  return process.env.EXECUTION_MODE === "live" ? "live" : "paper";
}

export function readExecutionConfig(): ExecutionConfig {
  return {
    executionMode: getExecutionMode(),
    enableLiveTrading: getEnvBoolean("ENABLE_LIVE_TRADING", false),
    algodUrl: process.env.ALGOD_URL ?? "https://mainnet-api.algonode.cloud",
    algodToken: process.env.ALGORAND_TOKEN || undefined,
    payerMnemonic: process.env.PAYER_MNEMONIC,
    orderQuantity: getEnvNumber("ORDER_QUANTITY", 1),
    minPriceCents: getEnvNumber("MIN_PRICE_CENTS", 2),
    maxPriceCents: getEnvNumber("MAX_PRICE_CENTS", 98),
    maxActiveOrders: getEnvNumber("MAX_ACTIVE_ORDERS", 2),
    maxUsdcaAtRiskCents: getEnvNumber("MAX_USDCA_AT_RISK_CENTS", 100),
    tickIntervalMs: getEnvNumber("TICK_INTERVAL_MS", 60_000),
    moveScoreDeltaPct: getEnvNumber("MOVE_SCORE_DELTA_PCT", 12),
    minDwellSeconds: getEnvNumber("MIN_DWELL_SECONDS", 180),
    maxMovesPerHour: getEnvNumber("MAX_MOVES_PER_HOUR", 8),
    haltBlockMinutes: getEnvNumber("HALT_BLOCK_MINUTES", 6),
    statePath: resolve(process.env.BOT_STATE_PATH ?? "state/bot-state.json"),
  };
}

export function validateExecutionConfig(config: ExecutionConfig): void {
  if (
    config.minPriceCents < 1 ||
    config.maxPriceCents > 99 ||
    config.minPriceCents >= config.maxPriceCents
  ) {
    throw new Error("MIN_PRICE_CENTS/MAX_PRICE_CENTS must be within 1..99 and non-overlapping");
  }
  if (config.maxActiveOrders < 2) {
    throw new Error("MAX_ACTIVE_ORDERS must be at least 2 for two-sided quoting");
  }
  if (config.executionMode === "live" && !config.payerMnemonic?.trim()) {
    throw new Error("PAYER_MNEMONIC is required when EXECUTION_MODE=live");
  }
}
