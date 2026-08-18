import type { AlphaConfig } from "../../alpha/alphaConfig.js";
import { AmarokClient, McpSdkToolCaller } from "./client.js";
import { AlgorandPaymentBuilder } from "./payment.js";
import { type AgentWallet, walletFromMnemonic } from "./wallet.js";

export type AmarokRuntime = {
  client: AmarokClient;
  wallet: AgentWallet;
  close: () => Promise<void>;
};

export function createAmarokRuntime(config: AlphaConfig): AmarokRuntime {
  if (!config.amarokMcpUrl) {
    throw new Error("AMAROK_MCP_URL is required");
  }
  if (!config.walletMnemonic) {
    throw new Error("ALPHA_WALLET_MNEMONIC is required for Amarok x402 and execution signing");
  }
  const wallet = walletFromMnemonic(config.walletMnemonic);
  const caller = new McpSdkToolCaller(new URL(config.amarokMcpUrl));
  const paymentBuilder = new AlgorandPaymentBuilder(wallet, {
    algodUrl: config.algodServer,
    algodToken: config.algodToken,
    maxDailyBaseUnits: config.maxDailyX402BaseUnits,
  });
  const client = new AmarokClient(caller, paymentBuilder);
  return {
    client,
    wallet,
    close: () => client.close(),
  };
}
