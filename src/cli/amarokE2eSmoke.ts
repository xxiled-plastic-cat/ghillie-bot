/**
 * Gated Amarok paid/place e2e smoke (NEO-23).
 *
 * Default (dry-run): discovery → one cheap paid research call → unsigned
 * execution quote → decode/validate sign inputs. Never submits.
 *
 * Live place requires GHILLIE_E2E_LIVE=1 and --submit. Refuses to spend in
 * GitHub Actions. Fail-closed if origin/MCP health or discovery fails.
 */
import dotenv from "dotenv";
import algosdk from "algosdk";

import { parseExecutionQuotePayload } from "../integrations/algorand/submitUnsigned.js";
import { McpSdkToolCaller, AmarokClient } from "../integrations/amarok/client.js";
import { createAmarokCliRuntime, printCliError } from "./amarokShared.js";

dotenv.config();

const DEFAULT_MCP_URL = "https://amarok-mcp.compx.io/mcp";
const DEFAULT_PRICE = 0.45;
const DEFAULT_SIZE_SHARES = 1;

/** Expected x402 ceilings from Amarok discovery (operator docs). */
export const E2E_EXPECTED_USDC = {
  opportunitiesMicro: 5_000,
  executionQuoteMicro: 10_000,
  /** Dry-run total x402 (opportunities + execution quote), excluding ALGO fees. */
  dryRunTotalMicro: 15_000,
} as const;

export function isGitHubActions(): boolean {
  return process.env.GITHUB_ACTIONS === "true";
}

export function isLivePlaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GHILLIE_E2E_LIVE === "1";
}

export function assertMaySpend(env: NodeJS.ProcessEnv = process.env): void {
  if (env.GITHUB_ACTIONS === "true") {
    throw new Error(
      "amarok:e2e-smoke refuses to spend in GitHub Actions (paid x402 / place are operator-only)",
    );
  }
}

export function microUsdcToUsdc(micro: number | string): string {
  const n = typeof micro === "string" ? Number(micro) : micro;
  if (!Number.isFinite(n)) return "?";
  return (n / 1_000_000).toFixed(6).replace(/\.?0+$/, "") || "0";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function unwrapData(payload: unknown): unknown {
  const record = asRecord(payload);
  if (!record) return payload;
  if ("data" in record) return record.data;
  return payload;
}

/** Pull candidate market rows from an opportunities (or similar) payload. */
export function opportunityRows(payload: unknown): unknown[] {
  const data = unwrapData(payload);
  if (Array.isArray(data)) return data;
  const record = asRecord(data);
  if (!record) return [];
  for (const key of ["opportunities", "rewards", "spreads", "parity", "items", "markets"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

export type PickedMarket = {
  marketAppId: number;
  title?: string;
  outcome: "YES" | "NO";
  side: "bid" | "ask";
  price: number;
  sizeShares: number;
};

/**
 * Choose one cheap place candidate from paid research data.
 * Prefers an Amarok suggested quote when present; otherwise uses safe defaults.
 */
export function pickMarketFromOpportunities(
  payload: unknown,
  overrides: Partial<PickedMarket> = {},
): PickedMarket {
  if (overrides.marketAppId !== undefined) {
    return {
      marketAppId: overrides.marketAppId,
      title: overrides.title,
      outcome: overrides.outcome ?? "YES",
      side: overrides.side ?? "bid",
      price: overrides.price ?? DEFAULT_PRICE,
      sizeShares: overrides.sizeShares ?? DEFAULT_SIZE_SHARES,
    };
  }

  const rows = opportunityRows(payload);
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    const marketAppId = asNumber(record.marketAppId);
    if (marketAppId === undefined || marketAppId <= 0) continue;

    const nestedQuote = asRecord(record.quote) ?? asRecord(record.suggestedQuote);
    const outcomeRaw = (
      asString(overrides.outcome) ??
      asString(nestedQuote?.outcome) ??
      asString(record.outcome) ??
      "YES"
    ).toUpperCase();
    const sideRaw = (
      asString(overrides.side) ??
      asString(nestedQuote?.side) ??
      asString(record.side) ??
      "bid"
    ).toLowerCase();
    const price =
      overrides.price ??
      asNumber(nestedQuote?.price) ??
      asNumber(record.price) ??
      asNumber(record.yesBid) ??
      asNumber(record.bestBid) ??
      DEFAULT_PRICE;
    const sizeShares =
      overrides.sizeShares ??
      asNumber(nestedQuote?.sizeShares) ??
      asNumber(nestedQuote?.size) ??
      asNumber(record.sizeShares) ??
      DEFAULT_SIZE_SHARES;

    return {
      marketAppId,
      title: asString(record.title) ?? asString(record.slug),
      outcome: outcomeRaw === "NO" ? "NO" : "YES",
      side: sideRaw === "ask" ? "ask" : "bid",
      price: price > 0 && price < 1 ? price : DEFAULT_PRICE,
      sizeShares: sizeShares > 0 ? Math.min(sizeShares, DEFAULT_SIZE_SHARES) : DEFAULT_SIZE_SHARES,
    };
  }

  throw new Error(
    "No marketAppId found in opportunities payload; pass --market <marketAppId> or retry when research returns rows",
  );
}

/** Redact secrets / long signatures from log objects. */
export function redactForLog(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForLog);
  const record = asRecord(value);
  if (!record) {
    if (typeof value === "string" && value.length > 120) {
      return `${value.slice(0, 24)}…(${value.length} chars)`;
    }
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("mnemonic") ||
      lower.includes("secret") ||
      lower.includes("private") ||
      lower === "sk"
    ) {
      out[key] = "[redacted]";
      continue;
    }
    if (
      lower.includes("paymentsignature") ||
      lower === "payment-signature" ||
      lower.includes("paymentsignatureheader")
    ) {
      out[key] = typeof entry === "string" ? `[redacted signature len=${entry.length}]` : "[redacted]";
      continue;
    }
    if (lower === "unsignedtxnsbase64" || lower === "encodedtransactions") {
      if (Array.isArray(entry)) {
        out[key] = `[${entry.length} txn(s) omitted]`;
        continue;
      }
    }
    out[key] = redactForLog(entry);
  }
  return out;
}

export function summarizeUnsignedTxns(unsignedTxnsBase64: string[]): Array<{
  index: number;
  type: string;
  sender?: string;
  fee?: number;
}> {
  return unsignedTxnsBase64.map((b64, index) => {
    const txn = algosdk.decodeUnsignedTransaction(Buffer.from(b64, "base64"));
    return {
      index,
      type: String(txn.type ?? "unknown"),
      sender: txn.sender?.toString(),
      fee: typeof txn.fee === "bigint" ? Number(txn.fee) : typeof txn.fee === "number" ? txn.fee : undefined,
    };
  });
}

function readArg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function assertOriginHttpHealthy(): Promise<void> {
  const base = process.env.AMAROK_API_ORIGIN || "https://amarok-api.compx.io";
  for (const path of ["/health", "/discovery"]) {
    const url = `${base}${path}`;
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      throw new Error(`Amarok origin ${url} returned HTTP ${response.status} (fail-closed)`);
    }
  }
  console.log(`origin healthy: ${base}/health and /discovery → 200`);
}

async function runFreeDiscovery(mcpUrl: string): Promise<{ health: unknown; discovery: unknown }> {
  const caller = new McpSdkToolCaller(new URL(mcpUrl));
  const client = new AmarokClient(caller, undefined);
  try {
    console.log(`MCP: ${mcpUrl}`);
    const [health, discovery] = await Promise.all([client.health(), client.getDiscovery()]);
    console.log("MCP health ok");
    console.log("MCP discovery ok");
    return { health, discovery };
  } finally {
    await client.close();
  }
}

export type E2eSmokeResult = {
  status: "ok" | "failed";
  mode: "dry-run" | "live-submit";
  walletAddress?: string;
  opportunityCount?: number;
  researchPaymentMicroUsdc?: string;
  quotePaymentMicroUsdc?: string;
  totalX402MicroUsdc?: string;
  market?: PickedMarket;
  unsignedTxnCount?: number;
  txnSummary?: ReturnType<typeof summarizeUnsignedTxns>;
  submitted?: unknown;
  note: string;
  error?: string;
};

export async function runAmarokE2eSmoke(options?: {
  liveSubmit?: boolean;
  marketAppId?: number;
  price?: number;
  sizeShares?: number;
  outcome?: "YES" | "NO";
  side?: "bid" | "ask";
}): Promise<E2eSmokeResult> {
  assertMaySpend();

  const liveSubmit = options?.liveSubmit === true;
  if (liveSubmit && !isLivePlaceEnabled()) {
    throw new Error("Live submit requires GHILLIE_E2E_LIVE=1 (default is dry-run only)");
  }

  const mcpUrl = process.env.AMAROK_MCP_URL || DEFAULT_MCP_URL;

  await assertOriginHttpHealthy();
  await runFreeDiscovery(mcpUrl);

  const { runtime, walletAddress, config } = createAmarokCliRuntime();
  const payments: string[] = [];

  try {
    console.log(`x402 payer / agent: ${walletAddress}`);
    console.log(
      `expected dry-run x402 ≈ ${microUsdcToUsdc(E2E_EXPECTED_USDC.dryRunTotalMicro)} USDC ` +
        `(opportunities ≤${microUsdcToUsdc(E2E_EXPECTED_USDC.opportunitiesMicro)} + ` +
        `execution quote ≤${microUsdcToUsdc(E2E_EXPECTED_USDC.executionQuoteMicro)}; plus ALGO fees)`,
    );

    console.log("step: paid research amarok_list_opportunities limit=5");
    const research = await runtime.client.listOpportunities(walletAddress, { limit: 5 });
    if (research.payment) {
      payments.push(research.payment.amountBaseUnits);
      console.log(
        `x402 payment: ${research.payment.amountBaseUnits} micro-USDC ` +
          `(${microUsdcToUsdc(research.payment.amountBaseUnits)} USDC) on ${research.payment.resourcePath}`,
      );
    }
    const rows = opportunityRows(research.data);
    console.log(`opportunities returned: ${rows.length}`);
    if (rows.length === 0) {
      throw new Error("Paid opportunities returned zero rows (fail-closed; incomplete research data)");
    }

    const market = pickMarketFromOpportunities(research.data, {
      marketAppId: options?.marketAppId,
      price: options?.price,
      sizeShares: options?.sizeShares,
      outcome: options?.outcome,
      side: options?.side,
    });
    console.log(
      `step: unsigned quote market=${market.marketAppId}` +
        (market.title ? ` (${market.title})` : "") +
        ` ${market.outcome} ${market.side} @ ${market.price} size=${market.sizeShares}`,
    );

    const quote = await runtime.client.getExecutionQuote(walletAddress, [
      {
        shapeKey: "alpha_place_limit_order",
        input: {
          marketAppId: market.marketAppId,
          outcome: market.outcome,
          side: market.side,
          price: market.price,
          sizeShares: market.sizeShares,
        },
      },
    ]);
    if (quote.payment) {
      payments.push(quote.payment.amountBaseUnits);
      console.log(
        `x402 payment: ${quote.payment.amountBaseUnits} micro-USDC ` +
          `(${microUsdcToUsdc(quote.payment.amountBaseUnits)} USDC) on ${quote.payment.resourcePath}`,
      );
    }

    const parsed = parseExecutionQuotePayload(quote.data);
    console.log(`unsigned txns: ${parsed.unsignedTxnsBase64.length}`);
    console.log(`userSignIndexes: ${JSON.stringify(parsed.userSignIndexes ?? "all")}`);
    console.log(`createEscrowIndex: ${parsed.createEscrowIndex ?? "n/a"}`);
    console.log(`known escrowAppId from quote: ${parsed.escrowAppId ?? "n/a"}`);

    const txnSummary = summarizeUnsignedTxns(parsed.unsignedTxnsBase64);
    console.log("dry-run sign path (decoded, not signed):");
    console.log(JSON.stringify(txnSummary, null, 2));
    console.log("redacted quote payload (truncated):");
    console.log(JSON.stringify(redactForLog(quote.data), null, 2).slice(0, 4_000));

    const totalX402 = payments.reduce((sum, part) => sum + BigInt(part), 0n).toString();

    if (!liveSubmit) {
      console.log("Dry-run complete. Live place is off (set GHILLIE_E2E_LIVE=1 and pass --submit).");
      return {
        status: "ok",
        mode: "dry-run",
        walletAddress,
        opportunityCount: rows.length,
        researchPaymentMicroUsdc: payments[0],
        quotePaymentMicroUsdc: payments[1],
        totalX402MicroUsdc: totalX402,
        market,
        unsignedTxnCount: parsed.unsignedTxnsBase64.length,
        txnSummary,
        note: "Dry-run only: discovery + paid opportunities + unsigned quote decoded; no sign/submit",
      };
    }

    console.log("LIVE SUBMIT enabled (GHILLIE_E2E_LIVE=1 --submit): signing and sending…");
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
    console.log(JSON.stringify(redactForLog(submitted), null, 2));
    return {
      status: "ok",
      mode: "live-submit",
      walletAddress,
      opportunityCount: rows.length,
      researchPaymentMicroUsdc: payments[0],
      quotePaymentMicroUsdc: payments[1],
      totalX402MicroUsdc: totalX402,
      market,
      unsignedTxnCount: parsed.unsignedTxnsBase64.length,
      txnSummary,
      submitted: redactForLog(submitted),
      note: "Live place submitted via algod",
    };
  } finally {
    await runtime.close();
  }
}

const isDirectRun = process.argv[1]?.match(/amarokE2eSmoke\.(ts|js)$/) != null;
if (isDirectRun) {
  const wantSubmit = hasFlag("--submit");
  const marketRaw = readArg("--market", process.env.AMAROK_DRY_MARKET_APP_ID);
  const marketAppId = marketRaw ? Number(marketRaw) : undefined;
  const priceRaw = readArg("--price");
  const sizeRaw = readArg("--size");
  const outcomeRaw = (readArg("--outcome", "YES") ?? "YES").toUpperCase();
  const sideRaw = (readArg("--side", "bid") ?? "bid").toLowerCase();

  try {
    if (wantSubmit && !isLivePlaceEnabled()) {
      throw new Error(
        "Refusing --submit: set GHILLIE_E2E_LIVE=1 to enable gated live place (default is dry-run)",
      );
    }
    const result = await runAmarokE2eSmoke({
      liveSubmit: wantSubmit && isLivePlaceEnabled(),
      marketAppId:
        marketAppId !== undefined && Number.isFinite(marketAppId) && marketAppId > 0
          ? marketAppId
          : undefined,
      price: priceRaw ? Number(priceRaw) : undefined,
      sizeShares: sizeRaw ? Number(sizeRaw) : undefined,
      outcome: outcomeRaw === "NO" ? "NO" : "YES",
      side: sideRaw === "ask" ? "ask" : "bid",
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    printCliError(error);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "failed",
          mode: wantSubmit ? "live-submit" : "dry-run",
          error: error instanceof Error ? error.message : String(error),
          note: "Fail-closed; no live place unless GHILLIE_E2E_LIVE=1 and --submit",
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  }
}
