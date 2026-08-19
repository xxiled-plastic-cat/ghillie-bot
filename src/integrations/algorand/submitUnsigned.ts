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
    /** Some shapes put createEscrowIndex on the item; live Amarok usually nests it under `group`. */
    createEscrowIndex: z.number().int().nonnegative().optional(),
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
  const record =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
  if (!record) return;
  const meta =
    record.meta && typeof record.meta === "object"
      ? (record.meta as Record<string, unknown>)
      : undefined;
  if (meta?.executionSubmitted === true) {
    throw new Error("Amarok unexpectedly reported executionSubmitted=true");
  }
  const data = record.data;
  const items = Array.isArray(data) ? data : data ? [data] : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const itemMeta =
      (item as Record<string, unknown>).meta &&
      typeof (item as Record<string, unknown>).meta === "object"
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
  createEscrowIndex?: number;
  userSignIndexes?: number[];
} {
  assertNotSubmitted(payload);
  const parsed = executionQuoteResponseSchema.parse(payload);
  const item = Array.isArray(parsed.data) ? parsed.data[0] : parsed.data;
  if (!item) throw new Error("Amarok execution quote returned no data");
  return {
    unsignedTxnsBase64: extractUnsignedTxns(item),
    escrowAppId: item.escrowAppId,
    createEscrowIndex: item.createEscrowIndex ?? item.group?.createEscrowIndex,
    userSignIndexes: item.userSignIndexes,
  };
}

function asPositiveAppId(value: unknown): number | undefined {
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

/**
 * Escrow apps are often created as an *inner* appl create on a later group
 * member — not on the first (pay/axfer) txn that sendRawTransaction returns.
 */
export function extractCreatedAppId(confirmation: Record<string, unknown>): number | undefined {
  const direct = asPositiveAppId(
    confirmation["application-index"] ??
      confirmation.applicationIndex ??
      confirmation["created-application-index"] ??
      confirmation.createdApplicationIndex,
  );
  if (direct !== undefined) return direct;

  const inner = confirmation["inner-txns"] ?? confirmation.innerTxns;
  if (!Array.isArray(inner)) return undefined;
  for (const entry of inner) {
    if (!entry || typeof entry !== "object") continue;
    const found = extractCreatedAppId(entry as Record<string, unknown>);
    if (found !== undefined) return found;
  }
  return undefined;
}

function txIdsFromSignedGroup(signed: Uint8Array[]): string[] {
  return signed.map((blob) => algosdk.decodeSignedTransaction(blob).txn.txID());
}

/** Prefer the create-escrow member, then scan the rest of the group. */
function confirmationWaitOrder(txIds: string[], createEscrowIndex?: number): string[] {
  if (
    createEscrowIndex === undefined ||
    !Number.isInteger(createEscrowIndex) ||
    createEscrowIndex < 0 ||
    createEscrowIndex >= txIds.length
  ) {
    return [...txIds];
  }
  const preferred = txIds[createEscrowIndex]!;
  return [preferred, ...txIds.filter((id) => id !== preferred)];
}

/**
 * Amarok sometimes returns unsigned groups whose baked-in `group` digest does
 * not match algosdk/algod's hash of the same txn bodies (→ "incomplete group").
 * Always clear + re-assign before signing so the submitted set is self-consistent.
 */
export function regroupUnsignedTransactions(unsignedTxnsBase64: string[]): algosdk.Transaction[] {
  const decoded = unsignedTxnsBase64.map((encoded) =>
    algosdk.decodeUnsignedTransaction(Buffer.from(encoded, "base64")),
  );
  for (const txn of decoded) {
    txn.group = undefined;
  }
  return algosdk.assignGroupID(decoded);
}

export function signUnsignedGroup(params: {
  wallet: AgentWallet;
  unsignedTxnsBase64: string[];
  userSignIndexes?: number[];
}): Uint8Array[] {
  const signIndexes = new Set(
    params.userSignIndexes && params.userSignIndexes.length > 0
      ? params.userSignIndexes
      : params.unsignedTxnsBase64.map((_, index) => index),
  );
  const grouped = regroupUnsignedTransactions(params.unsignedTxnsBase64);

  return grouped.map((txn, index) => {
    if (!signIndexes.has(index)) {
      throw new Error(
        `Amarok execution quote left txn index ${index} unsigned without provider signature support`,
      );
    }
    const sender = txn.sender.toString();
    if (sender !== params.wallet.address) {
      throw new Error(
        `Execution txn sender ${sender} does not match agent wallet ${params.wallet.address}`,
      );
    }
    return txn.signTxn(params.wallet.secretKey);
  });
}

export async function signAndSubmitUnsignedGroup(params: {
  wallet: AgentWallet;
  algodServer: string;
  algodToken?: string;
  unsignedTxnsBase64: string[];
  userSignIndexes?: number[];
  knownEscrowAppId?: number;
  createEscrowIndex?: number;
}): Promise<UnsignedSubmitResult> {
  const algod = new algosdk.Algodv2(params.algodToken ?? "", params.algodServer, "");
  const signed = signUnsignedGroup(params);
  const txIds = txIdsFromSignedGroup(signed);

  const submitted = (await algod.sendRawTransaction(signed).do()) as {
    txid?: string;
    txId?: string;
  };
  const submittedTxId = submitted.txid ?? submitted.txId;
  if (!submittedTxId) throw new Error("algod sendRawTransaction returned no txid");

  let escrowAppId = params.knownEscrowAppId;
  let confirmedRound: number | undefined;
  const waitOrder = confirmationWaitOrder(txIds, params.createEscrowIndex);

  for (const txId of waitOrder) {
    const confirmation = (await algosdk.waitForConfirmation(algod, txId, 8)) as unknown as Record<
      string,
      unknown
    >;
    const confirmedRoundRaw = confirmation["confirmed-round"] ?? confirmation.confirmedRound;
    confirmedRound = asFiniteNumber(confirmedRoundRaw) ?? confirmedRound;
    if (escrowAppId === undefined) {
      escrowAppId = extractCreatedAppId(confirmation);
    }
    // Once we have escrow + a confirmed round, remaining waits are unnecessary.
    if (escrowAppId !== undefined && confirmedRound !== undefined) break;
  }

  if (escrowAppId === undefined) {
    throw new Error(
      `Could not determine escrowAppId from confirmation for tx group [${txIds.join(", ")}] (submitted=${submittedTxId})`,
    );
  }

  return {
    txIds,
    confirmedRound,
    escrowAppId,
  };
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}
