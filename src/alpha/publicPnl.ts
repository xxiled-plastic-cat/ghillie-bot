import { type BotStateStore, createBotStateStore } from "../integrations/storage/botStateStore.js";
import type { AlphaDashboardSnapshot, DashboardRealPnl } from "./alphaDashboardData.js";

export const PUBLIC_PNL_OBJECT_NAME = "pnl";

export type GhilliePublicPnl = {
  schemaVersion: 1;
  agentId: "ghillie";
  walletAddress: string;
  asOf: string;
  /** Brownie-compatible / Amarok website consumer fields. */
  summary: {
    pnlUsd: string | null;
    pnlAvailable: boolean;
    navUsd: string | null;
    previousNavUsd: string | null;
    totalEconomicUsd: string | null;
    tradingPnlUsd: string | null;
    cashUsdc: string | null;
    positionsValueUsd: string | null;
    rewardsReceivedUsd: string | null;
  };
  navUsd: string | null;
  previousNavUsd: string | null;
  pnlUsd: string | null;
  pnlAvailable: boolean;
};

function moneyString(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value.toFixed(6);
}

function readPreviousNav(previous: unknown): number | null {
  if (!previous || typeof previous !== "object") return null;
  const root = previous as Record<string, unknown>;
  const summary =
    root.summary && typeof root.summary === "object"
      ? (root.summary as Record<string, unknown>)
      : root;
  const candidates = [summary.navUsd, root.navUsd];
  for (const raw of candidates) {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim() !== "") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

export function buildGhilliePublicPnl(input: {
  walletAddress: string;
  asOf: string;
  realPnl?: DashboardRealPnl;
  previous?: unknown;
}): GhilliePublicPnl {
  const navUsd =
    input.realPnl?.netWorthUsd ??
    (input.realPnl
      ? (input.realPnl.cashUsdc ?? 0) + input.realPnl.bidEscrowUsd + input.realPnl.positionsValueUsd
      : undefined);
  const previousNavUsd = readPreviousNav(input.previous);
  const pnlAvailable =
    navUsd !== undefined &&
    Number.isFinite(navUsd) &&
    previousNavUsd !== null &&
    Number.isFinite(previousNavUsd);
  const pnlUsd = pnlAvailable ? (navUsd as number) - (previousNavUsd as number) : null;

  const summary = {
    pnlUsd: moneyString(pnlUsd),
    pnlAvailable,
    navUsd: moneyString(navUsd),
    previousNavUsd: moneyString(previousNavUsd),
    totalEconomicUsd: moneyString(input.realPnl?.totalEconomicUsd),
    tradingPnlUsd: moneyString(input.realPnl?.tradingPnlUsd),
    cashUsdc: moneyString(input.realPnl?.cashUsdc),
    positionsValueUsd: moneyString(input.realPnl?.positionsValueUsd),
    rewardsReceivedUsd: moneyString(input.realPnl?.rewardsReceivedUsd),
  };

  return {
    schemaVersion: 1,
    agentId: "ghillie",
    walletAddress: input.walletAddress,
    asOf: input.asOf,
    summary,
    navUsd: summary.navUsd,
    previousNavUsd: summary.previousNavUsd,
    pnlUsd: summary.pnlUsd,
    pnlAvailable: summary.pnlAvailable,
  };
}

export async function publishGhilliePublicPnl(
  snapshot: AlphaDashboardSnapshot,
  store: BotStateStore = createBotStateStore(),
): Promise<string | undefined> {
  if (!snapshot.walletAddress) return undefined;
  if (!snapshot.realPnl) return undefined;

  let previous: unknown;
  try {
    previous = await store.getPublicJson(PUBLIC_PNL_OBJECT_NAME);
  } catch {
    previous = undefined;
  }

  const payload = buildGhilliePublicPnl({
    walletAddress: snapshot.walletAddress,
    asOf: snapshot.asOf,
    realPnl: snapshot.realPnl,
    previous,
  });

  return store.putPublicJson(PUBLIC_PNL_OBJECT_NAME, payload);
}
