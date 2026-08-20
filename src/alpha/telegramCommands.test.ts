import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { LocalFilesystemBotStateStore } from "../integrations/storage/botStateStore.js";
import type { AlphaConfig } from "./alphaConfig.js";
import {
  applyLaneOverrides,
  clearLaneOverride,
  getLaneOverrides,
  normalizeLaneOverrides,
  setLaneOverride,
  setLaneOverrideStoreForTests,
} from "./laneOverrideStore.js";
import {
  createCommandDispatcher,
  createLaneCommandHandlers,
  HELP_TEXT,
  isAllowedTelegramChat,
  parseTelegramCommand,
} from "./telegramCommands.js";

function baseConfig(overrides: Partial<AlphaConfig> = {}): AlphaConfig {
  return {
    amarokMcpUrl: "https://example.test/mcp",
    maxDailyX402BaseUnits: 0n,
    amarokResearchSku: "off",
    algodServer: "https://algod.test",
    indexerServer: "https://idx.test",
    matcherAppId: 1,
    usdcAssetId: 2,
    orderbookFetchConcurrency: 1,
    scanOrderbookLimit: 10,
    spreadScanOrderbookLimit: 10,
    maxMarketsPerScan: 0,
    scanIntervalMs: 10_000,
    streamTimeoutMs: 15_000,
    minDailyRewardUsd: 1,
    minRewardZoneCents: 2,
    rewardZoneBufferCents: 0.5,
    maxRewardCompetition: "medium",
    enableRewardLane: true,
    rewardRequireRealDaily: true,
    rewardTargetQuoteSizeUsd: 3,
    rewardMinOrderSizeUsd: 3,
    rewardMaxOrderSizeUsd: 3,
    rewardMaxMarketExposureUsd: 6,
    rewardMaxTotalExposureUsd: 12,
    rewardMaxLiveOpenOrders: 6,
    rewardMaxLiveOrdersPerMarket: 2,
    minEdgeBps: 75,
    parityBufferBps: 75,
    enableParityLane: false,
    enableParityArb: false,
    parityMinTradeUsd: 1,
    parityMinEdgeBps: 150,
    parityMaxTradeUsd: 1,
    parityMaxDailyUsd: 3,
    parityQueueLimit: 3,
    paritySlotReserve: 0,
    paritySlippageCents: 0.25,
    parityMinDepthUsd: 1,
    parityRequireImmediateMerge: true,
    minMakerSpreadCents: 4,
    enableSpreadLane: true,
    enableSpreadCapture: true,
    actualRewardRefreshInLive: false,
    spreadTargetOrderSizeUsd: 1,
    spreadMinOrderSizeUsd: 1,
    spreadMaxOrderSizeUsd: 3,
    spreadOrderSizeUsd: 1,
    minSpreadCaptureCents: 1,
    minSpreadVolumeUsd: 1,
    minSpreadDepthUsd: 0.25,
    spreadPersistenceScans: 2,
    spreadExitSlotReserve: 2,
    minSpreadEntryMidpoint: 0.05,
    minSpreadExitMidpoint: 0.01,
    spreadEntryMinDwellSeconds: 600,
    spreadExitEdgeCents: 1,
    spreadExitMinDwellSeconds: 1_800,
    underwaterExitEnabled: true,
    underwaterExitMinAgeHours: 24,
    underwaterExitMaxLossCents: 2,
    underwaterExitMaxNotionalUsd: 1,
    underwaterExitMaxMarketLossUsd: 1,
    staleInventoryAgeHours: 72,
    staleInventoryMaxLossCents: 25,
    inventoryExitMaxNotionalUsd: 50,
    inventoryExitFullPosition: true,
    enableInventoryMerge: true,
    inventoryMergeMinShares: 1,
    enableResolvedClaim: true,
    maxInventoryNotionalUsd: 0,
    rewardRateCalibration: 1,
    maxSpreadMidpoint: 0.99,
    spreadMaxMarketExposureUsd: 2,
    spreadMaxTotalExposureUsd: 12,
    spreadMaxLiveOpenOrders: 6,
    spreadMaxLiveOrdersPerMarket: 2,
    maxSpreadMarketExposureUsd: 2,
    minTimeToCloseMinutes: 60,
    maxTimeToCloseHours: 168,
    minMidpoint: 0.2,
    maxMidpoint: 0.8,
    targetQuoteSizeUsd: 3,
    maxOrderSizeUsd: 3,
    maxMarketExposureUsd: 6,
    maxTotalExposureUsd: 12,
    maxOpenOrders: 10,
    maxLiveOpenOrders: 6,
    maxLiveOrdersPerMarket: 2,
    liveBidUsdcBufferBps: 750,
    quoteRefreshThresholdCents: 1,
    minAlgoBalance: 3,
    rewardMinDwellSeconds: 180,
    orderRefreshMs: 15_000,
    paperStartingBalanceUsd: 50,
    enableLiveTrading: false,
    confirmRisk: false,
    stateKey: "alpha",
    eventLogPath: "logs/alpha-paper-events.jsonl",
    ...overrides,
  };
}

function commandCtx(
  overrides: Partial<{
    chatId: string;
    command: { name: string; args: string; raw: string };
    reply: (text: string) => Promise<void>;
  }> = {},
) {
  return {
    chatId: "1",
    command: { name: "help", args: "", raw: "/help" },
    reply: async () => undefined,
    ...overrides,
  };
}

describe("parseTelegramCommand", () => {
  it("parses slash commands and strips bot username", () => {
    assert.deepEqual(parseTelegramCommand("/lane"), {
      name: "lane",
      args: "",
      raw: "/lane",
    });
    assert.deepEqual(parseTelegramCommand("/lane@GhillieBot reward off"), {
      name: "lane",
      args: "reward off",
      raw: "/lane@GhillieBot reward off",
    });
    assert.deepEqual(parseTelegramCommand("/STATUS"), {
      name: "status",
      args: "",
      raw: "/STATUS",
    });
  });

  it("returns undefined for non-commands", () => {
    assert.equal(parseTelegramCommand(undefined), undefined);
    assert.equal(parseTelegramCommand("hello"), undefined);
    assert.equal(parseTelegramCommand("/"), undefined);
    assert.equal(parseTelegramCommand("  "), undefined);
  });
});

describe("isAllowedTelegramChat", () => {
  it("accepts matching chat ids as string or number", () => {
    assert.equal(isAllowedTelegramChat("123", "123"), true);
    assert.equal(isAllowedTelegramChat(123, "123"), true);
    assert.equal(isAllowedTelegramChat("999", "123"), false);
  });
});

describe("createCommandDispatcher", () => {
  it("routes known commands and hints on unknown", async () => {
    const dispatch = createCommandDispatcher({
      help: async () => "help-ok",
    });
    assert.equal(
      await dispatch(commandCtx({ command: { name: "help", args: "", raw: "/help" } })),
      "help-ok",
    );

    const unknown = await dispatch(
      commandCtx({ command: { name: "nope", args: "", raw: "/nope" } }),
    );
    assert.match(unknown, /Unknown command \/nope/);
    assert.match(unknown, /\/lanes/);
  });
});

describe("applyLaneOverrides", () => {
  it("prefers explicit overrides over env defaults", () => {
    const base = baseConfig({
      enableRewardLane: true,
      enableSpreadLane: true,
      enableParityLane: false,
    });
    const merged = applyLaneOverrides(base, {
      reward: false,
      parity: true,
      updatedAt: "2026-08-07T00:00:00.000Z",
      source: "telegram",
    });
    assert.equal(merged.enableRewardLane, false);
    assert.equal(merged.enableSpreadLane, true);
    assert.equal(merged.enableParityLane, true);
  });

  it("treats missing override keys as env defaults", () => {
    const base = baseConfig({ enableParityLane: false });
    const merged = applyLaneOverrides(base, normalizeLaneOverrides({}));
    assert.equal(merged.enableParityLane, false);
    assert.equal(merged.enableRewardLane, true);
  });
});

describe("laneOverrideStore persistence", () => {
  let rootDir: string | undefined;

  afterEach(async () => {
    setLaneOverrideStoreForTests(undefined);
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it("sets, clears, and reloads lane overrides", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "ghillie-lane-overrides-"));
    setLaneOverrideStoreForTests(
      new LocalFilesystemBotStateStore({ rootDir, prefix: "ghillie-bot" }),
    );

    assert.deepEqual(await getLaneOverrides(), {
      updatedAt: null,
      source: null,
    });

    const setResult = await setLaneOverride("parity", true, "telegram");
    assert.equal(setResult.parity, true);
    assert.equal(setResult.source, "telegram");
    assert.ok(setResult.updatedAt);

    const loaded = await getLaneOverrides();
    assert.equal(loaded.parity, true);
    assert.equal(loaded.reward, undefined);

    const cleared = await clearLaneOverride("parity", "telegram");
    assert.equal(cleared.parity, undefined);
    assert.equal(await getLaneOverrides().then((o) => o.parity), undefined);
  });
});

describe("createLaneCommandHandlers", () => {
  let rootDir: string | undefined;

  afterEach(async () => {
    setLaneOverrideStoreForTests(undefined);
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
      rootDir = undefined;
    }
  });

  it("handles help, lanes, and lane on/off/default", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "ghillie-lane-cmds-"));
    setLaneOverrideStoreForTests(
      new LocalFilesystemBotStateStore({ rootDir, prefix: "ghillie-bot" }),
    );

    const handlers = createLaneCommandHandlers({
      getCronHealth: () => ({
        running: false,
        schedule: "*/2 * * * *",
        command: "npm run alpha:live",
        lastTickStartedAt: "2026-08-07T12:00:00.000Z",
        lastTickEndedAt: "2026-08-07T12:01:00.000Z",
        lastTickExitCode: 0,
      }),
      getX402Spend: async () => ({
        dayUtc: "2026-08-07",
        timezone: "UTC" as const,
        amarok: {
          usedUsdc: "0.12",
          capUsdc: "5",
          remainingUsdc: "4.88",
          uncapped: false,
          callCount: 2,
        },
        lastRun: {
          callCount: 2,
          usedUsdc: "0.12",
          usedBaseUnits: "120000",
        },
      }),
    });

    assert.equal(await handlers.help!(commandCtx()), HELP_TEXT);

    const status = await handlers.status!(
      commandCtx({ command: { name: "status", args: "", raw: "/status" } }),
    );
    assert.match(status, /cron_busy: no/);
    assert.match(status, /reward:/);
    assert.match(status, /Amarok x402 today \(UTC\): \$0\.12 used, \$4\.88 remaining/);
    assert.match(status, /Amarok x402 last run: 2 call\(s\), \$0\.12 USDC/);
    assert.doesNotMatch(status, /paymentSignature/);

    await assert.rejects(
      () =>
        handlers.lane!(
          commandCtx({ command: { name: "lane", args: "nope on", raw: "/lane nope on" } }),
        ),
      /Unknown lane/,
    );

    await assert.rejects(
      () =>
        handlers.lane!(
          commandCtx({ command: { name: "lane", args: "reward", raw: "/lane reward" } }),
        ),
      /Usage:/,
    );

    const off = await handlers.lane!(
      commandCtx({
        command: { name: "lane", args: "reward off", raw: "/lane reward off" },
      }),
    );
    assert.match(off, /Lane reward → off/);
    assert.match(off, /override:off/);

    const def = await handlers.lane!(
      commandCtx({
        command: { name: "lane", args: "reward default", raw: "/lane reward default" },
      }),
    );
    assert.match(def, /env default/);

    const lanes = await handlers.lanes!(
      commandCtx({ command: { name: "lanes", args: "", raw: "/lanes" } }),
    );
    assert.match(lanes, /Lane status/);
  });
});
