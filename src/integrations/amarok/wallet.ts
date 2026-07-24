import algosdk from "algosdk";

export interface AgentWallet {
  address: string;
  secretKey: Uint8Array;
}

export function walletFromMnemonic(mnemonic: string): AgentWallet {
  const account = algosdk.mnemonicToSecretKey(mnemonic);
  return {
    address: account.addr.toString(),
    secretKey: account.sk,
  };
}
