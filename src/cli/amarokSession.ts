import { createAmarokCliRuntime, printCliError } from "./amarokShared.js";

async function main(): Promise<void> {
  const { runtime, walletAddress } = createAmarokCliRuntime();
  try {
    console.log(`x402 payer / agent: ${walletAddress}`);
    const result = await runtime.client.createResearchSession(walletAddress, { ttlSeconds: 60 });
    if (result.payment) {
      console.log(
        `x402 payment: ${result.payment.amountBaseUnits} micro-USDC on ${result.payment.resourcePath}`,
      );
    }
    const session = runtime.client.getResearchSession();
    if (session) {
      console.log(`session token expiresAt=${session.expiresAt} ttlSeconds=${session.ttlSeconds ?? "?"}`);
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
