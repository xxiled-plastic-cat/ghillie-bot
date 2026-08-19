import dotenv from "dotenv";

import { readPolyConfig } from "./polyConfig.js";
import {
  printPolyMarketDetail,
  printPolyPaperReport,
  printPolyPaperWatch,
  printPolyRewards,
  printPolyScan,
} from "./polyFormatter.js";
import { loadPolyScan } from "./polyMarketScanner.js";
import { buildPolyPaperReport } from "./polyPaperPnlTracker.js";
import { loadPolyPaperReportState, runPolyPaperTick } from "./polyPaperTrader.js";
import { scanPolyParity } from "./polyParityScanner.js";
import { rankPolyRewardCandidates } from "./polyRewardScanner.js";
import { rankPolySpreadCandidates } from "./polySpreadScanner.js";
import type { PolyMarket } from "./polyTypes.js";

dotenv.config();

type ScanBundle = Awaited<ReturnType<typeof buildPolyScan>>;

async function buildPolyScan(): Promise<{
  config: ReturnType<typeof readPolyConfig>;
  scan: Awaited<ReturnType<typeof loadPolyScan>>;
  rewardCandidates: ReturnType<typeof rankPolyRewardCandidates>;
  spreadCandidates: ReturnType<typeof rankPolySpreadCandidates>;
  parityPlans: ReturnType<typeof scanPolyParity>;
}> {
  const config = readPolyConfig();
  const scan = await loadPolyScan(config);
  const rewardCandidates = rankPolyRewardCandidates(
    scan.markets,
    scan.tokenBooksByConditionId,
    config,
  );
  const spreadCandidates = rankPolySpreadCandidates(
    scan.markets,
    scan.tokenBooksByConditionId,
    config,
  );
  const parityPlans = scanPolyParity(scan.markets, scan.tokenBooksByConditionId, config);
  return { config, scan, rewardCandidates, spreadCandidates, parityPlans };
}

function findMarket(scan: ScanBundle["scan"], needle: string): PolyMarket | undefined {
  const normalized = needle.trim().toLowerCase();
  if (!normalized) return undefined;
  return scan.markets.find((market) => {
    return (
      market.conditionId.toLowerCase() === normalized ||
      market.marketSlug?.toLowerCase() === normalized ||
      market.marketId?.toLowerCase() === normalized ||
      market.tokens.some((token) => token.tokenId.toLowerCase() === normalized)
    );
  });
}

async function runScanCommand(): Promise<void> {
  const { config, scan, rewardCandidates, spreadCandidates, parityPlans } = await buildPolyScan();
  printPolyScan(scan, rewardCandidates, spreadCandidates, parityPlans, config);
}

async function runRewardsCommand(): Promise<void> {
  const { rewardCandidates } = await buildPolyScan();
  printPolyRewards(rewardCandidates);
}

async function runMarketCommand(arg: string | undefined): Promise<void> {
  if (!arg)
    throw new Error("Usage: npm run poly:market -- <market-slug-or-condition-id-or-token-id>");
  const { scan } = await buildPolyScan();
  const market = findMarket(scan, arg);
  if (!market) throw new Error(`Polymarket market not found: ${arg}`);
  printPolyMarketDetail(market, scan.tokenBooksByConditionId.get(market.conditionId));
}

async function runPaperCommand(): Promise<void> {
  const config = readPolyConfig();
  const result = await runPolyPaperTick(config);
  printPolyPaperWatch(result);
}

async function runPaperWatchCommand(): Promise<void> {
  const config = readPolyConfig();
  const loop = async () => {
    try {
      const result = await runPolyPaperTick(config);
      printPolyPaperWatch(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${new Date().toISOString().slice(11, 19)}] poly_paper_failed: ${message}`);
    }
  };
  await loop();
  setInterval(loop, config.paperScanIntervalMs);
}

async function runPaperReportCommand(): Promise<void> {
  const config = readPolyConfig();
  const state = await loadPolyPaperReportState(config);
  const conservative = buildPolyPaperReport("conservative", state, config);
  const balanced = buildPolyPaperReport("balanced", state, config);
  printPolyPaperReport(state, conservative, balanced);
}

function printUsage(): void {
  console.log(
    "Usage: tsx src/polymarket/polyCommands.ts <scan|rewards|market|paper|paper-watch|paper-report>",
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "scan") return runScanCommand();
  if (command === "rewards") return runRewardsCommand();
  if (command === "market") return runMarketCommand(process.argv[3]);
  if (command === "paper") return runPaperCommand();
  if (command === "paper-watch") return runPaperWatchCommand();
  if (command === "paper-report") return runPaperReportCommand();
  printUsage();
  process.exitCode = 1;
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
