import algosdk from "algosdk";

import type { AlphaConfig } from "./alphaConfig.js";

const MICRO = 1_000_000n;

export type WalletUsdcTransfer = {
  round?: number;
  txId?: string;
  sender: string;
  receiver: string;
  amountMicroUsdc: bigint;
  direction: "in" | "out";
};

export type WalletUsdcScanResult = {
  transfers: WalletUsdcTransfer[];
  pagesScanned: number;
  transactionsScanned: number;
};

type ParsedAssetTransfer = {
  sender?: string;
  receiver?: string;
  assetId?: bigint;
  amount?: bigint;
};

export function formatMicroUsdc(value: bigint): string {
  const whole = value / MICRO;
  const fraction = (value % MICRO).toString().padStart(6, "0");
  return `${whole.toString()}.${fraction}`;
}

export function microUsdcToUsd(value: bigint): number {
  return Number(value) / Number(MICRO);
}

export function parseNextToken(response: Record<string, unknown>): string | undefined {
  const nextToken = response["next-token"];
  if (typeof nextToken === "string" && nextToken.length > 0) return nextToken;
  const next = response.next;
  if (typeof next === "string" && next.length > 0) return next;
  const camel = response.nextToken;
  if (typeof camel === "string" && camel.length > 0) return camel;
  return undefined;
}

function parseBigIntAmount(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.floor(value));
  if (typeof value === "string" && value.length > 0) {
    try {
      return BigInt(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function collectAssetTransfers(
  txn: Record<string, unknown>,
  inheritedSender?: string,
): ParsedAssetTransfer[] {
  const transfers: ParsedAssetTransfer[] = [];
  const sender = typeof txn.sender === "string" ? txn.sender : inheritedSender;
  const transfer = txn.assetTransferTransaction;
  if (transfer && typeof transfer === "object") {
    const payload = transfer as Record<string, unknown>;
    const parsed: ParsedAssetTransfer = {
      sender: typeof payload.sender === "string" ? payload.sender : sender,
      receiver: typeof payload.receiver === "string" ? payload.receiver : undefined,
      assetId: parseBigIntAmount(payload.assetId),
      amount: parseBigIntAmount(payload.amount),
    };
    transfers.push(parsed);
  }
  const inner = txn.innerTxns;
  if (Array.isArray(inner)) {
    for (const child of inner) {
      if (child && typeof child === "object") {
        transfers.push(...collectAssetTransfers(child as Record<string, unknown>, sender));
      }
    }
  }
  return transfers;
}

export async function scanWalletUsdcTransfers(
  walletAddress: string,
  config: Pick<AlphaConfig, "algodToken" | "indexerServer" | "usdcAssetId">,
): Promise<WalletUsdcScanResult> {
  const indexer = new algosdk.Indexer(config.algodToken ?? "", config.indexerServer, "");
  const usdcAssetId = BigInt(config.usdcAssetId);
  const transfers: WalletUsdcTransfer[] = [];
  let nextToken: string | undefined;
  let pageCount = 0;
  let transactionCount = 0;
  let pageLimit = 200;

  while (true) {
    let response: Record<string, unknown> | undefined;
    let attempts = 0;
    while (!response) {
      attempts += 1;
      try {
        let query = indexer.searchForTransactions().address(walletAddress).limit(pageLimit);
        if (nextToken) {
          query = query.nextToken(nextToken);
        }
        response = (await query.do()) as unknown as Record<string, unknown>;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const timedOut = message.toLowerCase().includes("statement timeout");
        if (!timedOut || attempts >= 4) {
          throw new Error(
            `Wallet USDC transfer scan failed on page ${pageCount + 1} (next=${nextToken ?? "none"}, limit=${pageLimit}): ${message}`,
          );
        }
        pageLimit = Math.max(25, Math.floor(pageLimit / 2));
        await new Promise((resolve) => setTimeout(resolve, 500 * attempts));
      }
    }

    const transactions = Array.isArray(response.transactions) ? response.transactions : [];
    pageCount += 1;
    transactionCount += transactions.length;

    for (const transaction of transactions as Array<Record<string, unknown>>) {
      const round =
        typeof transaction.confirmedRound === "number" ? transaction.confirmedRound : undefined;
      const txId = typeof transaction.id === "string" ? transaction.id : undefined;
      for (const transfer of collectAssetTransfers(transaction)) {
        if (transfer.assetId !== usdcAssetId) continue;
        if (transfer.amount === undefined || transfer.amount <= 0n) continue;
        if (!transfer.sender || !transfer.receiver) continue;

        if (transfer.receiver === walletAddress) {
          transfers.push({
            round,
            txId,
            sender: transfer.sender,
            receiver: transfer.receiver,
            amountMicroUsdc: transfer.amount,
            direction: "in",
          });
        }
        if (transfer.sender === walletAddress) {
          transfers.push({
            round,
            txId,
            sender: transfer.sender,
            receiver: transfer.receiver,
            amountMicroUsdc: transfer.amount,
            direction: "out",
          });
        }
      }
    }

    const parsedNext = parseNextToken(response);
    if (!parsedNext || parsedNext === nextToken || transactions.length === 0) break;
    nextToken = parsedNext;
  }

  return {
    transfers,
    pagesScanned: pageCount,
    transactionsScanned: transactionCount,
  };
}
