import algosdk from "algosdk";
import { z } from "zod";

import type { AgentWallet } from "../amarok/wallet.js";

const executionGroupSchema = z
  .object({
    unsignedTxnsBase64: z.array(z.string().min(1)).min(1).optional(),
    encodedTransactions: z.array(z.string().min(1)).min(1).optional(),
    createEscrowIndex: z.number().int().nonnegative().optional(),
    txnCount: z.number().int().positive().optional(),
  })
  .passthrough();

const executionQuoteItemSchema = z
  .object({
    shapeKey: z.string().optional(),
    unsignedTxnsBase64: z.array(z.string().min(1)).min(1).optional(),
    encodedTransactions: z.array(z.string().min(1)).min(1).optional(),
    userSignIndexes: z.array(z.number().int().nonnegative()).optional(),
    escrowAppId: z.number().int().positive().optional(),
    /** Live Amarok nests unsigned txns under `group` (not flattened). */
    group: executionGroupSchema.optional(),
    meta: z
      .object({
        executionSubmitted: z.literal(false).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const executionQuoteResponseSchema = z
  .object({
    data: z.union([executionQuoteItemSchema, z.array(executionQuoteItemSchema)]),
    meta: z
      .object({
        executionSubmitted: z.literal(false).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type UnsignedSubmitResult = {
  txIds: string[];
  confirmedRound?: number;
  escrowAppId: number;
  matchedQuantity?: number;
  matchedPrice?: number;
};

function extractUnsignedTxns(item: z.infer<typeof executionQuoteItemSchema>): string[] {
  const txns =
    item.unsignedTxnsBase64 ??
    item.encodedTransactions ??
    item.group?.unsignedTxnsBase64 ??
    item.group?.encodedTransactions;
  if (!txns || txns.length === 0) {
    const keys = Object.keys(item);
    const groupKeys = item.group ? Object.keys(item.group) : [];
    throw new Error(
      `Amarok execution quote missing unsignedTxnsBase64 (item keys=[${keys.join(", ")}]; group keys=[${groupKeys.join(", ")}])`,
    );
  }
  return txns;
}

function assertNotSubmitted(payload: unknown): void {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
  if (!record) return;
  const meta = record.meta && typeof record.meta === "object" ? (record.meta as Record<string, unknown>) : undefined;
  if (meta?.executionSubmitted === true) {
    throw new Error("Amarok unexpectedly reported executionSubmitted=true");
  }
  const data = record.data;
  const items = Array.isArray(data) ? data : data ? [data] : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const itemMeta =
      (item as Record<string, unknown>).meta && typeof (item as Record<string, unknown>).meta === "object"
        ? ((item as Record<string, unknown>).meta as Record<string, unknown>)
        : undefined;
    if (itemMeta?.executionSubmitted === true) {
      throw new Error("Amarok unexpectedly reported executionSubmitted=true on quote item");
    }
  }
}

export function parseExecutionQuotePayload(payload: unknown): {
  unsignedTxnsBase64: string[];
  escrowAppId?: number;
  userSignIndexes?: number[];
} {
  assertNotSubmitted(payload);
  const parsed = executionQuoteResponseSchema.parse(payload);
  const item = Array.isArray(parsed.data) ? parsed.data[0] : parsed.data;
  if (!item) throw new Error("Amarok execution quote returned no data");
  return {
    unsignedTxnsBase64: extractUnsignedTxns(item),
    escrowAppId: item.escrowAppId,
    userSignIndexes: item.userSignIndexes,
  };
}

function extractCreatedAppId(confirmation: Record<string, unknown>): number | undefined {
  const direct =
    (typeof confirmation["application-index"] === "number" && confirmation["application-index"]) ||
    (typeof confirmation.applicationIndex === "number" && confirmation.applicationIndex) ||
    undefined;
  if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) return direct;

  const inner = confirmation["inner-txns"] ?? confirmation.innerTxns;
  if (!Array.isArray(inner)) return undefined;
  for (const entry of inner) {
    if (!entry || typeof entry !== "object") continue;
    const found = extractCreatedAppId(entry as Record<string, unknown>);
    if (found !== undefined) return found;
  }
  return undefined;
}

export async function signAndSubmitUnsignedGroup(params: {
  wallet: AgentWallet;
  algodServer: string;
  algodToken?: string;
  unsignedTxnsBase64: string[];
  userSignIndexes?: number[];
  knownEscrowAppId?: number;
}): Promise<UnsignedSubmitResult> {
  const algod = new algosdk.Algodv2(params.algodToken ?? "", params.algodServer, "");
  const signIndexes = new Set(
    params.userSignIndexes && params.userSignIndexes.length > 0
      ? params.userSignIndexes
      : params.unsignedTxnsBase64.map((_, index) => index),
  );

  const signed: Uint8Array[] = params.unsignedTxnsBase64.map((encoded, index) => {
    const txn = algosdk.decodeUnsignedTransaction(Buffer.from(encoded, "base64"));
    if (!signIndexes.has(index)) {
      throw new Error(`Amarok execution quote left txn index ${index} unsigned without provider signature support`);
    }
    const sender = txn.sender.toString();
    if (sender !== params.wallet.address) {
      throw new Error(`Execution txn sender ${sender} does not match agent wallet ${params.wallet.address}`);
    }
    return txn.signTxn(params.wallet.secretKey);
  });

  const submitted = (await algod.sendRawTransaction(signed).do()) as { txid?: string; txId?: string };
  const txId = submitted.txid ?? submitted.txId;
  if (!txId) throw new Error("algod sendRawTransaction returned no txid");

  const confirmation = (await algosdk.waitForConfirmation(algod, txId, 8)) as unknown as Record<string, unknown>;
  const confirmedRoundRaw = confirmation["confirmed-round"] ?? confirmation.confirmedRound;
  const confirmedRound = typeof confirmedRoundRaw === "bigint" ? Number(confirmedRoundRaw) : asFiniteNumber(confirmedRoundRaw);
  const escrowAppId = params.knownEscrowAppId ?? extractCreatedAppId(confirmation);
  if (escrowAppId === undefined) {
    throw new Error(`Could not determine escrowAppId from confirmation for tx ${txId}`);
  }

  return {
    txIds: [txId],
    confirmedRound,
    escrowAppId,
  };
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}
