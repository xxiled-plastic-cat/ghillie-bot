import type { AmarokClient } from "../integrations/amarok/client.js";
import { createAmarokCliRuntime, printCliError } from "./amarokShared.js";

const LANES = ["rewards", "spreads", "parity"] as const;
type Lane = (typeof LANES)[number];

function isLane(value: string): value is Lane {
  return (LANES as readonly string[]).includes(value);
}

async function callLane(
  client: AmarokClient,
  walletAddress: string,
  lane: Lane,
): Promise<{ data: unknown; payment?: { amountBaseUnits: string; resourcePath: string } }> {
  const args = { limit: 10 };
  switch (lane) {
    case "rewards":
      return client.listRewards(walletAddress, args);
    case "spreads":
      return client.listSpreads(walletAddress, args);
    case "parity":
      return client.listParity(walletAddress, args);
  }
}

async function main(): Promise<void> {
  const laneArg = process.argv[2];
  if (!laneArg || !isLane(laneArg)) {
    throw new Error(`Usage: amarokLaneList.ts <${LANES.join("|")}>`);
  }

  const { runtime, walletAddress } = createAmarokCliRuntime();
  try {
    console.log(`x402 payer / agent: ${walletAddress}`);
    console.log(`lane: ${laneArg}`);
    const result = await callLane(runtime.client, walletAddress, laneArg);
    if (result.payment) {
      console.log(
        `x402 payment: ${result.payment.amountBaseUnits} micro-USDC on ${result.payment.resourcePath}`,
      );
    }
    console.log(JSON.stringify(result.data, null, 2));
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  printCliError(error);
  process.exitCode = 1;
});
