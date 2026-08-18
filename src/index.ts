import dotenv from "dotenv";
import type { ExecTickResult } from "./services/execRunner.js";
import { runExecutionTick } from "./services/execRunner.js";
import { readExecutionConfig, validateExecutionConfig } from "./services/executionConfig.js";
import { scanLadderInversions } from "./services/ladderScanner.js";
import { loadScanInputs } from "./services/marketScanner.js";
import { scanParity } from "./services/parityScanner.js";
import { rankLiquiditySignals, rankMakerCandidates } from "./services/rewardScanner.js";
import type { Ladder, Market } from "./types/market.js";
import {
  formatBps,
  formatCents,
  formatMinutes,
  formatPrice,
  formatTimeframe,
  padRight,
} from "./utils/format.js";
import { getHaltWindowMinutes, minutesUntil, TAKER_MATCH_FEE_BPS } from "./utils/math.js";

dotenv.config();

type EnvConfig = {
  minEdgeBps: number;
  scanIntervalMs: number;
  maxSpreadCents: number;
  minHaltBufferMinutes: number;
};

type CliOptions = {
  underlying?: string;
};

function getEnvNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

function readEnv(): EnvConfig {
  return {
    minEdgeBps: getEnvNumber("MIN_EDGE_BPS", 50),
    scanIntervalMs: getEnvNumber("SCAN_INTERVAL_MS", 10_000),
    maxSpreadCents: getEnvNumber("MAX_SPREAD_CENTS", 20),
    minHaltBufferMinutes: getEnvNumber("MIN_HALT_BUFFER_MINUTES", 2),
  };
}

function describeHaltMinutes(market: Market): number {
  const haltTs = market.haltTs ?? market.expiryTs - getHaltWindowMinutes(market.timeframe) * 60;
  return minutesUntil(haltTs);
}

function countTwoSidedQuotes(ladder: Ladder): number {
  return ladder.markets.filter(
    (market) =>
      market.yesBid !== undefined &&
      market.yesAsk !== undefined &&
      market.noBid !== undefined &&
      market.noAsk !== undefined,
  ).length;
}

function printLadder(ladder: Ladder): void {
  const minsToExpiry = minutesUntil(ladder.expiryTs);
  const haltIn = describeHaltMinutes(ladder.markets[0]);
  const twoSided = countTwoSidedQuotes(ladder);
  console.log(
    `${ladder.underlying} ${formatTimeframe(ladder.timeframe)} — expires in ${formatMinutes(
      minsToExpiry,
    )} — halt in ${formatMinutes(haltIn)} — two-sided ${twoSided}/${ladder.markets.length}`,
  );
  console.log("");
  console.log(
    `${padRight("Strike", 12)}${padRight("YES Bid", 10)}${padRight("YES Ask", 10)}${padRight(
      "Mid",
      9,
    )}${padRight("Spread", 10)}`,
  );
  for (const market of ladder.markets) {
    const mid =
      market.yesBid !== undefined && market.yesAsk !== undefined
        ? (market.yesBid + market.yesAsk) / 2
        : undefined;
    const spread =
      market.yesBid !== undefined && market.yesAsk !== undefined
        ? market.yesAsk - market.yesBid
        : undefined;
    console.log(
      `${padRight(market.strike.toFixed(0), 12)}${padRight(formatPrice(market.yesBid), 10)}${padRight(
        formatPrice(market.yesAsk),
        10,
      )}${padRight(formatPrice(mid), 9)}${padRight(spread !== undefined ? formatCents(spread) : "-", 10)}`,
    );
  }
  console.log("");
}

function filterByUnderlying(markets: Market[], underlying?: string): Market[] {
  if (!underlying) return markets;
  return markets.filter((market) => market.underlying.toUpperCase() === underlying.toUpperCase());
}

function filterLaddersByUnderlying(ladders: Ladder[], underlying?: string): Ladder[] {
  if (!underlying) return ladders;
  return ladders.filter((ladder) => ladder.underlying.toUpperCase() === underlying.toUpperCase());
}

function getAverageLadderTwoSidedRatio(ladders: Ladder[]): number {
  if (ladders.length === 0) return 0;
  const total = ladders.reduce(
    (acc, ladder) => acc + countTwoSidedQuotes(ladder) / ladder.markets.length,
    0,
  );
  return total / ladders.length;
}

async function runScanOnceWithOptions(
  config: EnvConfig,
  options: CliOptions,
  printVerbose: boolean,
): Promise<{
  marketsCount: number;
  openCount: number;
  laddersCount: number;
  averageLadderTwoSidedRatio: number;
  ladderOpportunities: ReturnType<typeof scanLadderInversions>;
  parityOpportunities: ReturnType<typeof scanParity>;
  makerCandidates: ReturnType<typeof rankMakerCandidates>;
  liquiditySignals: ReturnType<typeof rankLiquiditySignals>;
}> {
  const { allMarkets, openMarkets, ladders, rewardMarkets } = await loadScanInputs({
    minHaltBufferMinutes: config.minHaltBufferMinutes,
  });

  const filteredOpenMarkets = filterByUnderlying(openMarkets, options.underlying);
  const filteredLadders = filterLaddersByUnderlying(ladders, options.underlying);

  const ladderOpportunities = scanLadderInversions(filteredLadders, config.minEdgeBps);
  const parityOpportunities = scanParity(filteredOpenMarkets, config.minEdgeBps);
  const makerCandidates = rankMakerCandidates(filteredOpenMarkets, rewardMarkets, {
    maxSpreadCents: config.maxSpreadCents,
    minHaltBufferMinutes: config.minHaltBufferMinutes,
  });
  const liquiditySignals = rankLiquiditySignals(filteredOpenMarkets, rewardMarkets, {
    maxSpreadCents: config.maxSpreadCents,
    minHaltBufferMinutes: config.minHaltBufferMinutes,
  });
  const averageLadderTwoSidedRatio = getAverageLadderTwoSidedRatio(filteredLadders);

  if (printVerbose) {
    console.log("GHILLIE v1");
    console.log("");
    if (options.underlying) {
      console.log(`Underlying filter: ${options.underlying.toUpperCase()}`);
      console.log("");
    }
    console.log(`Markets loaded: ${allMarkets.length}`);
    console.log(`Open markets: ${filteredOpenMarkets.length}`);
    console.log(`Ladders found: ${filteredLadders.length}`);
    console.log(`Ladder two-sided coverage: ${(averageLadderTwoSidedRatio * 100).toFixed(1)}%`);
    console.log("");

    for (const ladder of filteredLadders) {
      printLadder(ladder);
    }

    for (const opp of ladderOpportunities.slice(0, 8)) {
      console.log("[LADDER INVERSION]");
      console.log(
        `${opp.underlying} ${formatTimeframe(opp.timeframe)} ${opp.lowerStrike.toFixed(0)} / ${opp.higherStrike.toFixed(
          0,
        )}`,
      );
      console.log(
        `Buy lower YES at ${opp.lowerYesAsk.toFixed(2)}, sell higher YES at ${opp.higherYesBid.toFixed(2)}`,
      );
      console.log(`Raw edge: ${formatBps(opp.edgeBps)}`);
      console.log(`After taker match fee: ${formatBps(opp.takerAdjustedEdgeBps)}`);
      console.log("Settlement fee may apply if winning taker position settles in profit.");
      console.log("");
    }

    for (const opp of parityOpportunities.slice(0, 8)) {
      console.log("[PARITY]");
      console.log(
        `${opp.underlying} ${formatTimeframe(opp.timeframe)} ${opp.strike.toFixed(0)} (${opp.kind.replace("_", " ")})`,
      );
      if (opp.kind === "cheap_pair") {
        console.log(`YES ask + NO ask = ${(opp.yesPrice + opp.noPrice).toFixed(2)}`);
      } else {
        console.log(`YES bid + NO bid = ${(opp.yesPrice + opp.noPrice).toFixed(2)}`);
      }
      console.log(`Raw edge: ${formatBps(opp.edgeBps)}`);
      console.log(`After taker match fee: ${formatBps(opp.takerAdjustedEdgeBps)}`);
      console.log("Settlement fee may apply if winning taker position settles in profit.");
      console.log("");
    }

    for (const candidate of makerCandidates.slice(0, 8)) {
      console.log("[MAKER CANDIDATE]");
      console.log(
        `${candidate.underlying} ${formatTimeframe(candidate.timeframe)} ${candidate.strike.toFixed(0)}`,
      );
      console.log(`Midpoint: ${candidate.yesMid.toFixed(2)}`);
      console.log(`Spread: ${formatCents(candidate.spread)}`);
      console.log(`ATM weight: ${candidate.atmWeight.toFixed(2)}`);
      console.log(`Reason: ${candidate.reason}`);
      console.log("");
    }

    for (const signal of liquiditySignals.slice(0, 10)) {
      console.log("[LIQUIDITY SIGNAL]");
      console.log(
        `${signal.underlying} ${formatTimeframe(signal.timeframe)} ${signal.strike.toFixed(0)} (${signal.kind})`,
      );
      console.log(`Score: ${(signal.score * 100).toFixed(1)} / 100`);
      console.log(
        `Book: ${signal.bookState}, midpoint=${signal.yesMid.toFixed(2)}, target spread=${formatCents(signal.spread)}`,
      );
      console.log(
        `Suggested YES ${signal.suggestedYesBid?.toFixed(2) ?? "-"} / ${signal.suggestedYesAsk?.toFixed(
          2,
        )}, NO ${signal.suggestedNoBid?.toFixed(2) ?? "-"} / ${signal.suggestedNoAsk?.toFixed(2) ?? "-"}`,
      );
      console.log(
        `Reward alloc: ${signal.rewardAllocation.toFixed(2)}, halt buffer: ${signal.haltBufferMinutes.toFixed(1)}m`,
      );
      console.log(`Why: ${signal.reason}`);
      console.log("");
    }
  }

  return {
    marketsCount: allMarkets.length,
    openCount: filteredOpenMarkets.length,
    laddersCount: filteredLadders.length,
    averageLadderTwoSidedRatio,
    ladderOpportunities,
    parityOpportunities,
    makerCandidates,
    liquiditySignals,
  };
}

function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--underlying" || token === "-u") {
      const value = argv[i + 1];
      if (value) {
        options.underlying = value;
        i += 1;
      }
    }
  }
  return options;
}

async function runScanCommand(options: CliOptions): Promise<void> {
  const config = readEnv();
  await runScanOnceWithOptions(config, options, true);
}

async function runWatchCommand(options: CliOptions): Promise<void> {
  const config = readEnv();
  const loop = async () => {
    const timestamp = new Date().toISOString().slice(11, 19);
    try {
      const result = await runScanOnceWithOptions(config, options, false);
      const top = result.liquiditySignals[0];
      const totalOpportunities =
        result.ladderOpportunities.length + result.parityOpportunities.length;
      const filterSuffix = options.underlying
        ? ` underlying=${options.underlying.toUpperCase()}`
        : "";
      if (top) {
        console.log(
          `[${timestamp}] markets=${result.openCount} ladders=${result.laddersCount} opportunities=${totalOpportunities} makerCandidates=${result.makerCandidates.length} liquiditySignals=${result.liquiditySignals.length} twoSided=${(
            result.averageLadderTwoSidedRatio * 100
          ).toFixed(1)}%${filterSuffix}`,
        );
        console.log(
          `Top: ${top.underlying} ${formatTimeframe(top.timeframe)} ${top.strike.toFixed(0)} ${top.kind}, suggested YES ${top.suggestedYesBid?.toFixed(
            2,
          )}/${top.suggestedYesAsk?.toFixed(2)}, score=${(top.score * 100).toFixed(1)}`,
        );
      } else {
        console.log(
          `[${timestamp}] markets=${result.openCount} ladders=${result.laddersCount} opportunities=${totalOpportunities} makerCandidates=0 liquiditySignals=0 twoSided=${(
            result.averageLadderTwoSidedRatio * 100
          ).toFixed(1)}%${filterSuffix}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${timestamp}] scan_failed: ${message}`);
    }
  };

  await loop();
  setInterval(loop, config.scanIntervalMs);
}

function printExecutionResult(result: ExecTickResult): void {
  const top = result.topTarget;
  console.log(`Execution mode: ${result.execution.mode}`);
  console.log(`Action: ${result.execution.action}`);
  console.log(`Reason: ${result.execution.reason}`);
  if (top) {
    console.log(
      `Top target: ${top.underlying} ${formatTimeframe(top.timeframe)} strike=${(
        top.strikeCents / 100
      ).toFixed(0)} market=${top.marketId}:${top.strikeIndex}`,
    );
    console.log(
      `Quotes: YES BUY ${top.yesBuyPriceCents}c x ${top.quantity}, NO BUY ${top.noBuyPriceCents}c x ${top.quantity}`,
    );
    console.log(`Score: ${(top.targetScore * 100).toFixed(1)} / 100`);
    console.log(`Why: ${top.reason}`);
  }
  if (result.execution.activeOrderIds.length > 0) {
    console.log(`Active order ids: ${result.execution.activeOrderIds.join(", ")}`);
  }
}

async function runTickExecCommand(options: CliOptions): Promise<void> {
  const scannerConfig = readEnv();
  const executionConfig = readExecutionConfig();
  validateExecutionConfig(executionConfig);
  const result = await runExecutionTick(executionConfig, {
    underlying: options.underlying,
    maxSpreadCents: scannerConfig.maxSpreadCents,
    minHaltBufferMinutes: scannerConfig.minHaltBufferMinutes,
  });
  printExecutionResult(result);
}

async function runWatchExecCommand(options: CliOptions): Promise<void> {
  const scannerConfig = readEnv();
  const executionConfig = readExecutionConfig();
  validateExecutionConfig(executionConfig);
  const loop = async () => {
    const timestamp = new Date().toISOString().slice(11, 19);
    try {
      const result = await runExecutionTick(executionConfig, {
        underlying: options.underlying,
        maxSpreadCents: scannerConfig.maxSpreadCents,
        minHaltBufferMinutes: scannerConfig.minHaltBufferMinutes,
      });
      const top = result.topTarget;
      const topSummary = top
        ? `${top.underlying} ${formatTimeframe(top.timeframe)} ${Math.round(top.strikeCents / 100)} YES=${top.yesBuyPriceCents}c NO=${top.noBuyPriceCents}c score=${(
            top.targetScore * 100
          ).toFixed(1)}`
        : "none";
      console.log(
        `[${timestamp}] mode=${result.execution.mode} action=${result.execution.action} reason="${result.execution.reason}" top=${topSummary}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${timestamp}] exec_failed: ${message}`);
    }
  };

  await loop();
  setInterval(loop, executionConfig.tickIntervalMs);
}

function printUsage(): void {
  console.log(
    "Usage: tsx src/index.ts <scan|watch|tick-exec|watch-exec> [--underlying BTC|ETH|XAU|SPY]",
  );
  console.log(`Taker match fee assumption: ${TAKER_MATCH_FEE_BPS.toFixed(1)} bps`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const options = parseCliOptions(process.argv.slice(3));
  if (command === "scan") {
    await runScanCommand(options);
    return;
  }
  if (command === "watch") {
    await runWatchCommand(options);
    return;
  }
  if (command === "tick-exec") {
    await runTickExecCommand(options);
    return;
  }
  if (command === "watch-exec") {
    await runWatchExecCommand(options);
    return;
  }
  printUsage();
  process.exitCode = 1;
}

void main();
