import dotenv from "dotenv";

import { readAlphaConfig } from "../alpha/alphaConfig.js";
import { createAmarokRuntime } from "../integrations/amarok/runtime.js";

dotenv.config();

export function createAmarokCliRuntime() {
  const config = readAlphaConfig();
  if (!config.walletMnemonic) {
    throw new Error("ALPHA_WALLET_MNEMONIC is required for Amarok CLI commands");
  }
  if (!config.walletAddress) {
    throw new Error("ALPHA_WALLET_ADDRESS or mnemonic-derived address is required");
  }
  const runtime = createAmarokRuntime(config);
  return { config, runtime, walletAddress: config.walletAddress };
}

export function printCliError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Amarok command failed: ${message}`);
}
