import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AmarokClient, ManagedToolResult } from "../integrations/amarok/client.js";
import type { AmarokRuntime } from "../integrations/amarok/runtime.js";
import type { AlphaConfig } from "./alphaConfig.js";
import { loadAlphaScan } from "./alphaMarketScanner.js";

function testConfig(overrides: Partial<AlphaConfig> = {}): AlphaConfig {
  return {
    amarokMcpUrl: "https://example.test/mcp",
    amarokResearchSku: "off",
    walletAddress: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
    walletMnemonic:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    enableRewardLane: true,
    enableSpreadLane: true,
    enableParityLane: false,
    maxMarketsPerScan: 10,
    ...overrides,
  } as AlphaConfig;
}

function emptyResult(data: unknown = { data: { markets: [] } }): ManagedToolResult {
  return { data };
}

function mockRuntime(calls: string[], options: { tools?: string[] } = {}): AmarokRuntime {
  const tools = options.tools ?? [];
  const client = {
    async listTools() {
      return tools.map((name) => ({ name, inputSchema: { type: "object", properties: {} } }));
    },
    async getScan() {
      calls.push("amarok_get_scan");
      return emptyResult({
        data: {
          markets: [
            {
              marketAppId: 3100000001,
              title: "Sample",
              status: "live",
              resolved: false,
              book: { bestBid: 0.4, bestAsk: 0.45 },
              reward: { isRewardMarket: true, dailyRewardsUsd: 5 },
            },
          ],
        },
      });
    },
    async getQuotes() {
      calls.push("amarok_get_quotes");
      return emptyResult({ data: [] });
    },
    async listOpportunities() {
      calls.push("amarok_list_opportunities");
      return emptyResult({
        data: [
          { kind: "lp_reward", marketAppId: 3100000001, title: "Sample", estimatedUsdPerDay: "5" },
        ],
      });
    },
    async listRewards() {
      calls.push("amarok_list_rewards");
      return emptyResult({
        data: [{ marketAppId: 3100000001, title: "Sample", estimatedUsdPerDay: "5" }],
      });
    },
    async listSpreads() {
      calls.push("amarok_list_spreads");
      return emptyResult({ data: [] });
    },
    async listParity() {
      calls.push("amarok_list_parity");
      return emptyResult({ data: [] });
    },
    async getResearchBundle() {
      calls.push("amarok_get_research_bundle");
      return emptyResult({
        opportunities: [
          { kind: "lp_reward", marketAppId: 3100000001, title: "Sample", estimatedUsdPerDay: "5" },
        ],
        quotes: [],
        markets: [],
      });
    },
    async createResearchSession() {
      calls.push("amarok_create_research_session");
      return emptyResult({
        session: {
          token: "test-session",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          ttlSeconds: 60,
        },
      });
    },
    async close() {},
  } as unknown as AmarokClient;

  return {
    client,
    wallet: {
      address: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ",
    } as AmarokRuntime["wallet"],
    close: async () => client.close(),
  };
}

describe("loadAlphaScan research mode", () => {
  it("uses lane tools when operator prefs are present", async () => {
    const calls: string[] = [];
    const scan = await loadAlphaScan(testConfig(), {
      loadOperatorPreferences: async () => "Prefer rewards then spreads.",
      createRuntime: () => mockRuntime(calls),
    });

    assert.equal(scan.researchMode, "lane");
    assert.equal(scan.researchSku, "per-request");
    assert.equal(scan.operatorPreferences, "Prefer rewards then spreads.");
    assert.ok(calls.includes("amarok_list_rewards"));
    assert.ok(calls.includes("amarok_list_spreads"));
    assert.ok(!calls.includes("amarok_list_opportunities"));
    assert.ok(!calls.includes("amarok_list_parity"));
  });

  it("uses mixed opportunities when prefs are missing", async () => {
    const calls: string[] = [];
    const scan = await loadAlphaScan(testConfig(), {
      loadOperatorPreferences: async () => undefined,
      createRuntime: () => mockRuntime(calls),
    });

    assert.equal(scan.researchMode, "legacy");
    assert.equal(scan.researchSku, "per-request");
    assert.equal(scan.operatorPreferences, undefined);
    assert.ok(calls.includes("amarok_list_opportunities"));
    assert.ok(!calls.includes("amarok_list_rewards"));
    assert.ok(!calls.includes("amarok_list_spreads"));
  });

  it("calls parity lane when prefs present and parity enabled", async () => {
    const calls: string[] = [];
    await loadAlphaScan(testConfig({ enableParityLane: true }), {
      loadOperatorPreferences: async () => "lane mode",
      createRuntime: () => mockRuntime(calls),
    });
    assert.ok(calls.includes("amarok_list_parity"));
  });

  it("uses bundle SKU in legacy mode when tool is available", async () => {
    const calls: string[] = [];
    const scan = await loadAlphaScan(testConfig({ amarokResearchSku: "bundle" }), {
      loadOperatorPreferences: async () => undefined,
      createRuntime: () => mockRuntime(calls, { tools: ["amarok_get_research_bundle"] }),
    });
    assert.equal(scan.researchSku, "bundle");
    assert.ok(calls.includes("amarok_get_research_bundle"));
    assert.ok(!calls.includes("amarok_get_quotes"));
    assert.ok(!calls.includes("amarok_list_opportunities"));
  });

  it("uses session SKU in lane mode when tool is available", async () => {
    const calls: string[] = [];
    const scan = await loadAlphaScan(testConfig({ amarokResearchSku: "session" }), {
      loadOperatorPreferences: async () => "lane prefs",
      createRuntime: () => mockRuntime(calls, { tools: ["amarok_create_research_session"] }),
    });
    assert.equal(scan.researchSku, "session");
    assert.ok(calls.includes("amarok_create_research_session"));
    assert.ok(calls.includes("amarok_get_quotes"));
    assert.ok(calls.includes("amarok_list_rewards"));
  });

  it("falls back to per-request when bundle tool is missing", async () => {
    const calls: string[] = [];
    const scan = await loadAlphaScan(testConfig({ amarokResearchSku: "bundle" }), {
      loadOperatorPreferences: async () => undefined,
      createRuntime: () => mockRuntime(calls, { tools: [] }),
    });
    assert.equal(scan.researchSku, "per-request");
    assert.ok(calls.includes("amarok_get_quotes"));
    assert.ok(calls.includes("amarok_list_opportunities"));
  });
});
