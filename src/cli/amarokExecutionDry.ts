import { createAmarokCliRuntime, printCliError } from "./amarokShared.js";
import { parseExecutionQuotePayload } from "../integrations/algorand/submitUnsigned.js";

function readArg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

async function main(): Promise<void> {
  const submit = process.argv.includes("--submit");
  const marketAppId = Number(readArg("--market", process.env.AMAROK_DRY_MARKET_APP_ID));
  const price = Number(readArg("--price", "0.45"));
  const sizeShares = Number(readArg("--size", "1"));
  const outcome = (readArg("--outcome", "YES") ?? "YES").toUpperCase() === "NO" ? "NO" : "YES";
  const side = (readArg("--side", "bid") ?? "bid").toLowerCase() === "ask" ? "ask" : "bid";

  if (!Number.isFinite(marketAppId) || marketAppId <= 0) {
    throw new Error("Usage: npm run amarok:execution-dry -- --market <marketAppId> [--price 0.45] [--size 1] [--submit]");
  }

  const { runtime, walletAddress, config } = createAmarokCliRuntime();
  try {
    console.log(`x402 payer / agent: ${walletAddress}`);
    console.log(`Building alpha_place_limit_order market=${marketAppId} ${outcome} ${side} @ ${price} size=${sizeShares}`);
    const result = await runtime.client.getExecutionQuote(walletAddress, [
      {
        shapeKey: "alpha_place_limit_order",
        input: { marketAppId, outcome, side, price, sizeShares },
      },
    ]);
    if (result.payment) {
      console.log(
        `x402 payment: ${result.payment.amountBaseUnits} micro-USDC on ${result.payment.resourcePath}`,
      );
    }
    const parsed = parseExecutionQuotePayload(result.data);
    console.log(`unsigned txns: ${parsed.unsignedTxnsBase64.length}`);
    console.log(`userSignIndexes: ${JSON.stringify(parsed.userSignIndexes ?? "all")}`);
    console.log(`createEscrowIndex: ${parsed.createEscrowIndex ?? "n/a"}`);
    console.log(`known escrowAppId from quote: ${parsed.escrowAppId ?? "n/a"}`);
    if (!submit) {
      console.log("Dry run only (pass --submit to sign and sendRawTransaction).");
      console.log(JSON.stringify(result.data, null, 2).slice(0, 4_000));
      return;
    }

    const { signAndSubmitUnsignedGroup } = await import("../integrations/algorand/submitUnsigned.js");
    const submitted = await signAndSubmitUnsignedGroup({
      wallet: runtime.wallet,
      algodServer: config.algodServer,
      algodToken: config.algodToken,
      unsignedTxnsBase64: parsed.unsignedTxnsBase64,
      userSignIndexes: parsed.userSignIndexes,
      knownEscrowAppId: parsed.escrowAppId,
      createEscrowIndex: parsed.createEscrowIndex,
    });
    console.log(JSON.stringify(submitted, null, 2));
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  printCliError(error);
  process.exitCode = 1;
});
