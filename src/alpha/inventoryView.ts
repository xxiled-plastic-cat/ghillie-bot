import type { OpenOrder, WalletPosition } from "@alpha-arcade/sdk";

import { fromMicroUnits } from "./alphaClient.js";
import type { AlphaBotState, AlphaMarket, AlphaOutcome, AlphaPaperPosition } from "./alphaTypes.js";

export const INVENTORY_SHARE_EPSILON = 1e-3;

export type InventorySide = {
  free: number;
  escrow: number;
  total: number;
};

export type MarketInventory = {
  marketAppId: number;
  title?: string;
  yes: InventorySide;
  no: InventorySide;
};

export type InventoryInvariantMismatch = {
  marketAppId: number;
  outcome: AlphaOutcome;
  stateShares: number;
  totalShares: number;
  free: number;
  escrow: number;
  message: string;
};

export type PositionMarketMeta = {
  marketId?: string;
  slug?: string;
  title?: string;
};

export function positionKey(marketAppId: number): string {
  return String(marketAppId);
}

export function escrowedSellSharesFor(
  walletOrders: OpenOrder[],
  marketAppId: number,
  outcome: AlphaOutcome,
): number {
  const positionFlag = outcome === "YES" ? 1 : 0;
  return walletOrders
    .filter(
      (order) =>
        order.marketAppId === marketAppId && order.side === 0 && order.position === positionFlag,
    )
    .reduce(
      (sum, order) =>
        sum + (fromMicroUnits(Math.max(0, order.quantity - order.quantityFilled)) ?? 0),
      0,
    );
}

function emptySide(): InventorySide {
  return { free: 0, escrow: 0, total: 0 };
}

function sideFrom(free: number, escrow: number): InventorySide {
  return { free, escrow, total: free + escrow };
}

export function getPosition(
  state: AlphaBotState,
  marketAppId: number,
): AlphaPaperPosition | undefined {
  return state.positionsByMarket[positionKey(marketAppId)];
}

export function ensurePositionByAppId(
  state: AlphaBotState,
  input: {
    marketAppId: number;
    marketId?: string;
    slug?: string;
    title?: string;
  },
): AlphaPaperPosition {
  const key = positionKey(input.marketAppId);
  const existing = state.positionsByMarket[key];
  if (existing) {
    if (input.marketId) existing.marketId = input.marketId;
    if (input.slug !== undefined) existing.slug = input.slug;
    if (input.title) existing.title = input.title;
    existing.marketAppId = input.marketAppId;
    return existing;
  }
  const created: AlphaPaperPosition = {
    marketId: input.marketId ?? key,
    marketAppId: input.marketAppId,
    slug: input.slug,
    title: input.title ?? `market ${input.marketAppId}`,
    yesShares: 0,
    noShares: 0,
    avgYesCost: 0,
    avgNoCost: 0,
    realisedPnl: 0,
    unrealisedPnl: 0,
  };
  state.positionsByMarket[key] = created;
  return created;
}

/**
 * Consolidate dual-keyed positions (UUID vs String(appId)) onto canonical
 * `String(marketAppId)` keys. Returns number of alias rows removed.
 */
export function migratePositionsToAppIdKeys(state: AlphaBotState): number {
  const keysByAppId = new Map<number, string[]>();
  for (const [key, position] of Object.entries(state.positionsByMarket)) {
    if (position.marketAppId === undefined) continue;
    const keys = keysByAppId.get(position.marketAppId) ?? [];
    keys.push(key);
    keysByAppId.set(position.marketAppId, keys);
  }

  let removed = 0;
  for (const [appId, keys] of keysByAppId) {
    const canonical = positionKey(appId);
    const uniqueKeys = [...new Set(keys)];
    if (uniqueKeys.length === 1 && uniqueKeys[0] === canonical) {
      const only = state.positionsByMarket[canonical];
      if (only) only.marketAppId = appId;
      continue;
    }

    if (uniqueKeys.length === 1 && uniqueKeys[0] !== canonical) {
      const onlyKey = uniqueKeys[0]!;
      const only = state.positionsByMarket[onlyKey];
      if (!only) continue;
      only.marketAppId = appId;
      only.marketId = only.marketId || canonical;
      state.positionsByMarket[canonical] = only;
      delete state.positionsByMarket[onlyKey];
      removed += 1;
      continue;
    }

    const candidates = uniqueKeys
      .map((key) => ({ key, position: state.positionsByMarket[key] }))
      .filter(
        (entry): entry is { key: string; position: AlphaPaperPosition } =>
          entry.position !== undefined,
      );
    if (candidates.length === 0) continue;

    candidates.sort(
      (a, b) =>
        b.position.yesShares + b.position.noShares - (a.position.yesShares + a.position.noShares),
    );
    const primary = candidates[0]!.position;
    const merged: AlphaPaperPosition = {
      ...primary,
      marketAppId: appId,
      marketId: primary.marketId || canonical,
      yesShares: primary.yesShares,
      noShares: primary.noShares,
      avgYesCost: primary.avgYesCost,
      avgNoCost: primary.avgNoCost,
      realisedPnl: primary.realisedPnl,
      unrealisedPnl: primary.unrealisedPnl,
      lastMark: primary.lastMark,
      unaccountedTicks: primary.unaccountedTicks,
    };

    for (const { key, position } of candidates.slice(1)) {
      if (merged.avgYesCost <= 0 && position.avgYesCost > 0)
        merged.avgYesCost = position.avgYesCost;
      if (merged.avgNoCost <= 0 && position.avgNoCost > 0) merged.avgNoCost = position.avgNoCost;
      if (!merged.slug && position.slug) merged.slug = position.slug;
      if (!merged.title && position.title) merged.title = position.title;
      if (merged.lastMark === undefined && position.lastMark !== undefined)
        merged.lastMark = position.lastMark;
      merged.realisedPnl += position.realisedPnl;
      merged.unaccountedTicks = Math.max(
        merged.unaccountedTicks ?? 0,
        position.unaccountedTicks ?? 0,
      );
      if (key !== canonical) {
        delete state.positionsByMarket[key];
        removed += 1;
      }
    }

    for (const { key } of candidates) {
      if (key !== canonical && state.positionsByMarket[key]) {
        delete state.positionsByMarket[key];
        removed += 1;
      }
    }

    state.positionsByMarket[canonical] = merged;
  }

  return removed;
}

export function buildInventorySnapshot(
  walletPositions: WalletPosition[],
  walletOrders: OpenOrder[],
): Map<number, MarketInventory> {
  const snapshot = new Map<number, MarketInventory>();

  for (const position of walletPositions) {
    const yesFree = fromMicroUnits(position.yesBalance) ?? 0;
    const noFree = fromMicroUnits(position.noBalance) ?? 0;
    const yesEscrow = escrowedSellSharesFor(walletOrders, position.marketAppId, "YES");
    const noEscrow = escrowedSellSharesFor(walletOrders, position.marketAppId, "NO");
    if (yesFree <= 0 && noFree <= 0 && yesEscrow <= 0 && noEscrow <= 0) continue;
    snapshot.set(position.marketAppId, {
      marketAppId: position.marketAppId,
      title: position.title,
      yes: sideFrom(yesFree, yesEscrow),
      no: sideFrom(noFree, noEscrow),
    });
  }

  for (const order of walletOrders) {
    if (order.side !== 0) continue;
    const remaining = fromMicroUnits(Math.max(0, order.quantity - order.quantityFilled)) ?? 0;
    if (remaining <= 0) continue;
    const existing = snapshot.get(order.marketAppId) ?? {
      marketAppId: order.marketAppId,
      yes: emptySide(),
      no: emptySide(),
    };
    if (order.position === 1) {
      existing.yes = sideFrom(
        existing.yes.free,
        escrowedSellSharesFor(walletOrders, order.marketAppId, "YES"),
      );
    } else {
      existing.no = sideFrom(
        existing.no.free,
        escrowedSellSharesFor(walletOrders, order.marketAppId, "NO"),
      );
    }
    snapshot.set(order.marketAppId, existing);
  }

  return snapshot;
}

function metaForAppId(
  marketAppId: number,
  marketByAppId: Map<number, AlphaMarket> | undefined,
  fallback?: PositionMarketMeta,
): PositionMarketMeta {
  const market = marketByAppId?.get(marketAppId);
  return {
    marketId: market?.id ?? fallback?.marketId ?? positionKey(marketAppId),
    slug: market?.slug ?? fallback?.slug,
    title: market?.title ?? fallback?.title ?? `market ${marketAppId}`,
  };
}

/**
 * Sync bot position share counts to free+escrow totals. Preserves avg cost unless
 * that side's total inventory is gone.
 */
export function syncPositionsFromInventory(
  state: AlphaBotState,
  snapshot: Map<number, MarketInventory>,
  marketByAppId?: Map<number, AlphaMarket>,
): number {
  let synced = 0;

  for (const [marketAppId, inventory] of snapshot) {
    const previous = getPosition(state, marketAppId);
    const meta = metaForAppId(marketAppId, marketByAppId, previous);
    const position = ensurePositionByAppId(state, {
      marketAppId,
      marketId: meta.marketId,
      slug: meta.slug,
      title: meta.title,
    });

    position.yesShares = inventory.yes.total;
    position.noShares = inventory.no.total;

    if (position.yesShares <= INVENTORY_SHARE_EPSILON) {
      position.yesShares = 0;
      position.avgYesCost = 0;
    } else if (previous) {
      position.avgYesCost = previous.avgYesCost;
    }

    if (position.noShares <= INVENTORY_SHARE_EPSILON) {
      position.noShares = 0;
      position.avgNoCost = 0;
    } else if (previous) {
      position.avgNoCost = previous.avgNoCost;
    }

    if (previous) {
      position.realisedPnl = previous.realisedPnl;
      position.unrealisedPnl = previous.unrealisedPnl;
      position.lastMark = previous.lastMark;
      position.unaccountedTicks = previous.unaccountedTicks;
    }

    synced += 1;
  }

  // Zero out sides for tracked markets that no longer appear in wallet/escrow.
  for (const [key, position] of Object.entries(state.positionsByMarket)) {
    if (position.marketAppId === undefined) continue;
    if (snapshot.has(position.marketAppId)) continue;
    if (
      position.yesShares <= INVENTORY_SHARE_EPSILON &&
      position.noShares <= INVENTORY_SHARE_EPSILON
    )
      continue;
    // Leave share counts for reconcile to decide; do not wipe avg here.
    void key;
  }

  return synced;
}

export function inventoryInvariantMismatches(
  state: AlphaBotState,
  snapshot: Map<number, MarketInventory>,
): InventoryInvariantMismatch[] {
  const mismatches: InventoryInvariantMismatch[] = [];
  const seen = new Set<number>();

  for (const [marketAppId, inventory] of snapshot) {
    seen.add(marketAppId);
    const position = getPosition(state, marketAppId);
    for (const outcome of ["YES", "NO"] as const) {
      const side = outcome === "YES" ? inventory.yes : inventory.no;
      const stateShares =
        outcome === "YES" ? (position?.yesShares ?? 0) : (position?.noShares ?? 0);
      if (Math.abs(stateShares - side.total) <= INVENTORY_SHARE_EPSILON) continue;
      mismatches.push({
        marketAppId,
        outcome,
        stateShares,
        totalShares: side.total,
        free: side.free,
        escrow: side.escrow,
        message: `Inventory invariant: appId=${marketAppId} ${outcome} state=${stateShares.toFixed(6)} total=${side.total.toFixed(
          6,
        )} (free=${side.free.toFixed(6)} escrow=${side.escrow.toFixed(6)})`,
      });
    }
  }

  for (const position of Object.values(state.positionsByMarket)) {
    if (position.marketAppId === undefined || seen.has(position.marketAppId)) continue;
    for (const outcome of ["YES", "NO"] as const) {
      const stateShares = outcome === "YES" ? position.yesShares : position.noShares;
      if (stateShares <= INVENTORY_SHARE_EPSILON) continue;
      mismatches.push({
        marketAppId: position.marketAppId,
        outcome,
        stateShares,
        totalShares: 0,
        free: 0,
        escrow: 0,
        message: `Inventory invariant: appId=${position.marketAppId} ${outcome} state=${stateShares.toFixed(
          6,
        )} total=0.000000 (free=0.000000 escrow=0.000000)`,
      });
    }
  }

  return mismatches;
}
