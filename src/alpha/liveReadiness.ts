import type { AlphaConfig } from "./alphaConfig.js";

export function getLiveReadinessWarnings(config: AlphaConfig): string[] {
  const warnings: string[] = [];
  if (!config.enableLiveTrading) warnings.push("ALPHA_ENABLE_LIVE_TRADING is not true");
  if (!config.confirmRisk) warnings.push("ALPHA_CONFIRM_RISK is not true");
  if (!config.walletAddress) warnings.push("ALPHA_WALLET_ADDRESS is missing");
  if (!config.walletMnemonic) warnings.push("ALPHA_WALLET_MNEMONIC is missing");
  if (!config.amarokMcpUrl) warnings.push("AMAROK_MCP_URL is missing");
  if (!config.apiKey) {
    warnings.push("ALPHA_API_KEY is missing (needed for Alpha SDK wallet open-order sync)");
  }
  return warnings;
}
