import { createBotStateStore, type BotStateStore } from "../integrations/storage/botStateStore.js";
import { readAlphaConfig, type AlphaConfig } from "./alphaConfig.js";

export const LANE_OVERRIDE_STATE_KEY = "lane-overrides";

export type LaneName = "reward" | "spread" | "parity";
export type LaneOverrideSource = "telegram" | "boot";

export type LaneOverrides = {
  reward?: boolean;
  spread?: boolean;
  parity?: boolean;
  updatedAt: string | null;
  source: LaneOverrideSource | null;
};

const EMPTY_OVERRIDES: LaneOverrides = {
  updatedAt: null,
  source: null,
};

let storeOverride: BotStateStore | undefined;

/** Test hook — inject a store (e.g. local FS temp dir). */
export function setLaneOverrideStoreForTests(store: BotStateStore | undefined): void {
  storeOverride = store;
}

function getStore(): BotStateStore {
  return storeOverride ?? createBotStateStore();
}

export function parseLaneName(raw: string): LaneName | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "reward" || normalized === "spread" || normalized === "parity") {
    return normalized;
  }
  return undefined;
}

export function normalizeLaneOverrides(raw: unknown): LaneOverrides {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...EMPTY_OVERRIDES };
  }
  const record = raw as Record<string, unknown>;
  const overrides: LaneOverrides = {
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    source:
      record.source === "telegram" || record.source === "boot" ? record.source : null,
  };
  if (typeof record.reward === "boolean") overrides.reward = record.reward;
  if (typeof record.spread === "boolean") overrides.spread = record.spread;
  if (typeof record.parity === "boolean") overrides.parity = record.parity;
  return overrides;
}

export function applyLaneOverrides(base: AlphaConfig, overrides: LaneOverrides): AlphaConfig {
  return {
    ...base,
    enableRewardLane: overrides.reward ?? base.enableRewardLane,
    enableSpreadLane: overrides.spread ?? base.enableSpreadLane,
    enableParityLane: overrides.parity ?? base.enableParityLane,
  };
}

export async function getLaneOverrides(): Promise<LaneOverrides> {
  const raw = await getStore().getJson(LANE_OVERRIDE_STATE_KEY);
  return normalizeLaneOverrides(raw);
}

export async function loadAlphaConfig(): Promise<AlphaConfig> {
  const base = readAlphaConfig();
  const overrides = await getLaneOverrides();
  return applyLaneOverrides(base, overrides);
}

export async function setLaneOverride(
  lane: LaneName,
  enabled: boolean,
  source: LaneOverrideSource = "telegram",
): Promise<LaneOverrides> {
  const current = await getLaneOverrides();
  const next: LaneOverrides = {
    ...current,
    [lane]: enabled,
    updatedAt: new Date().toISOString(),
    source,
  };
  await getStore().putJson(LANE_OVERRIDE_STATE_KEY, next);
  return next;
}

export async function clearLaneOverride(
  lane: LaneName,
  source: LaneOverrideSource = "telegram",
): Promise<LaneOverrides> {
  const current = await getLaneOverrides();
  const next: LaneOverrides = {
    updatedAt: new Date().toISOString(),
    source,
  };
  if (lane !== "reward" && current.reward !== undefined) next.reward = current.reward;
  if (lane !== "spread" && current.spread !== undefined) next.spread = current.spread;
  if (lane !== "parity" && current.parity !== undefined) next.parity = current.parity;
  await getStore().putJson(LANE_OVERRIDE_STATE_KEY, next);
  return next;
}

export type EffectiveLaneStatus = {
  lane: LaneName;
  envDefault: boolean;
  override: boolean | undefined;
  effective: boolean;
};

export function describeEffectiveLanes(
  base: AlphaConfig,
  overrides: LaneOverrides,
): EffectiveLaneStatus[] {
  return (
    [
      ["reward", base.enableRewardLane, overrides.reward],
      ["spread", base.enableSpreadLane, overrides.spread],
      ["parity", base.enableParityLane, overrides.parity],
    ] as const
  ).map(([lane, envDefault, override]) => ({
    lane,
    envDefault,
    override,
    effective: override ?? envDefault,
  }));
}

export function formatLaneStatusLines(
  base: AlphaConfig,
  overrides: LaneOverrides,
): string[] {
  return describeEffectiveLanes(base, overrides).map((row) => {
    const overrideLabel =
      row.override === undefined ? "env" : row.override ? "override:on" : "override:off";
    return `${row.lane}: ${row.effective ? "on" : "off"} (${overrideLabel}, env=${row.envDefault ? "on" : "off"})`;
  });
}
