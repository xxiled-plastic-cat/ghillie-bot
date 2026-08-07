import type { OpenOrder, WalletPosition } from "@alpha-arcade/sdk";

import type { AlphaConfig, AlphaMode } from "./alphaConfig.js";
import { AlphaSdkClient, fromMicroUnits } from "./alphaClient.js";
import { escrowedSellSharesFor, getPosition, positionKey } from "./inventoryView.js";
import { saveAlphaState } from "./alphaStateStore.js";
import type { AlphaBotState } from "./alphaTypes.js";

type MergeMode = Extract<AlphaMode, "live-dry-run" | "live">;

export type MergeAction = {
  kind: "merge" | "skip";
  message: string;
};

const MERGE_EPS = 1e-6;

function fmtUsd(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(4)}`;
}

/**
 * Mergeable sets are free-wallet matched YES/NO only, further capped by
 * tracked free-equivalent inventory (state total − sell escrow). Escrowed
 * sells are never mergeable.
 */
export function computeMergeSets(input: {
  freeYes: number;
  freeNo: number;
  stateYes?: number;
  stateNo?: number;
  escrowYes?: number;
  escrowNo?: number;
}): number {
  const freeMatched = Math.min(Math.max(0, input.freeYes), Math.max(0, input.freeNo));
  if (freeMatched <= MERGE_EPS) return 0;

  const stateYes = input.stateYes ?? Number.POSITIVE_INFINITY;
  const stateNo = input.stateNo ?? Number.POSITIVE_INFINITY;
  const escrowYes = Math.max(0, input.escrowYes ?? 0);
  const escrowNo = Math.max(0, input.escrowNo ?? 0);
  const freeYesTracked = Math.max(0, stateYes - escrowYes);
  const freeNoTracked = Math.max(0, stateNo - escrowNo);
  return Math.min(freeMatched, freeYesTracked, freeNoTracked);
}

export function applyMergeToState(state: AlphaBotState, marketAppId: number, sets: number): number {
  const position = getPosition(state, marketAppId);
  if (!position || sets <= MERGE_EPS) return 0;
  const avgYesCost = position.avgYesCost ?? 0;
  const avgNoCost = position.avgNoCost ?? 0;
  const realised = (1 - avgYesCost - avgNoCost) * sets;
  position.yesShares = Math.max(0, position.yesShares - sets);
  position.noShares = Math.max(0, position.noShares - sets);
  if (position.yesShares <= MERGE_EPS) {
    position.yesShares = 0;
    position.avgYesCost = 0;
  }
  if (position.noShares <= MERGE_EPS) {
    position.noShares = 0;
    position.avgNoCost = 0;
  }
  position.realisedPnl += realised;
  state.realisedPnl += realised;
  if (position.yesShares <= MERGE_EPS && position.noShares <= MERGE_EPS) {
    delete state.positionsByMarket[positionKey(marketAppId)];
  }
  return realised;
}

/**
 * Recover capital from inventory holding both YES and NO of the same market.
 * Each matched YES+NO set merges back into exactly $1 of USDC with no market
 * interaction, so this is risk-free and should run before any new placement.
 * Uses wallet free balances only (escrowed sells are not mergeable).
 */
export async function runInventoryMergeLane(input: {
  liveClient: AlphaSdkClient;
  config: AlphaConfig;
  mode: MergeMode;
  walletPositions: WalletPosition[];
  walletOrders?: OpenOrder[];
  state: AlphaBotState;
}): Promise<MergeAction[]> {
  const { liveClient, config, mode, walletPositions, state } = input;
  const walletOrders = input.walletOrders ?? [];
  if (!config.enableInventoryMerge) {
    return [{ kind: "skip", message: "Inventory merge disabled (ALPHA_ENABLE_INVENTORY_MERGE=false)" }];
  }
  const actions: MergeAction[] = [];
  const minShares = Math.max(0, config.inventoryMergeMinShares);

  for (const position of walletPositions) {
    const freeYes = fromMicroUnits(position.yesBalance) ?? 0;
    const freeNo = fromMicroUnits(position.noBalance) ?? 0;
    const tracked = getPosition(state, position.marketAppId);
    const escrowYes = escrowedSellSharesFor(walletOrders, position.marketAppId, "YES");
    const escrowNo = escrowedSellSharesFor(walletOrders, position.marketAppId, "NO");
    const sets = computeMergeSets({
      freeYes,
      freeNo,
      stateYes: tracked?.yesShares,
      stateNo: tracked?.noShares,
      escrowYes,
      escrowNo,
    });
    if (sets <= MERGE_EPS || sets < minShares) continue;

    let resolved = false;
    try {
      const resolution = await liveClient.getMarketResolution(position.marketAppId);
      resolved = resolution.isResolved === true;
    } catch {
      resolved = false;
    }
    if (resolved) {
      // Resolved markets cannot merge; the resolved claim lane recovers these.
      continue;
    }

    const title = position.title || `market ${position.marketAppId}`;
    if (mode === "live-dry-run") {
      actions.push({
        kind: "merge",
        message: `Would merge ${sets.toFixed(6)} set(s) ($${sets.toFixed(2)}) of ${title} back to USDC`,
      });
      continue;
    }

    try {
      const result = await liveClient.mergeShares({ marketAppId: position.marketAppId, amountShares: sets });
      const realised = applyMergeToState(state, position.marketAppId, sets);
      await saveAlphaState(config.stateKey, state);
      actions.push({
        kind: "merge",
        message: `Merged ${sets.toFixed(6)} set(s) ($${sets.toFixed(2)}) of ${title} back to USDC; realised=${fmtUsd(
          realised,
        )} txIds=${result.txIds.join(",")}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ghillie-live] inventory merge failed market=${position.marketAppId}: ${message}`);
      actions.push({ kind: "skip", message: `Inventory merge failed ${title}: ${message}` });
    }
  }

  return actions;
}
