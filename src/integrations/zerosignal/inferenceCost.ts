/** One ZeroSignal inference charge extracted from zs-proxy response headers. */
export interface InferenceCostCharge {
  /** Settled inference amount in USDC (decimal string). */
  amountUsdc: string;
  /** Related `X-Zs-*` headers from that response (for debugging / breakdown). */
  headers: Record<string, string>;
}

export interface InferenceCostSummary {
  charges: InferenceCostCharge[];
  /** Sum of charge amounts in USDC (decimal string). */
  totalUsdc: string;
  requestCount: number;
}

const INFERENCE_AMOUNT_HEADER = "x-zs-inference-amount";

/**
 * Pull ZeroSignal cost headers from a Responses API HTTP response.
 * Primary amount is `X-Zs-Inference-Amount` (USDC decimal).
 * Missing / invalid headers → skip that turn (do not invent a price).
 */
export function parseInferenceCostFromHeaders(
  headers: Headers | Record<string, string> | undefined,
): InferenceCostCharge | undefined {
  if (!headers) {
    return undefined;
  }
  const zsHeaders = collectZsHeaders(headers);
  const rawAmount =
    zsHeaders[INFERENCE_AMOUNT_HEADER] ?? lookupHeader(headers, INFERENCE_AMOUNT_HEADER);
  if (rawAmount === undefined || rawAmount.trim() === "") {
    return undefined;
  }
  const amount = parseUsdcAmount(rawAmount.trim());
  if (amount === undefined) {
    return undefined;
  }
  return {
    amountUsdc: formatUsdc(amount),
    headers: zsHeaders,
  };
}

export function summarizeInferenceCosts(
  charges: InferenceCostCharge[],
): InferenceCostSummary | undefined {
  if (charges.length === 0) {
    return undefined;
  }
  let totalMicros = 0n;
  for (const charge of charges) {
    const micros = usdcToMicros(charge.amountUsdc);
    if (micros === undefined) continue;
    totalMicros += micros;
  }
  return {
    charges,
    totalUsdc: formatUsdc(Number(totalMicros) / 1_000_000),
    requestCount: charges.length,
  };
}

/** Format a short human line for Telegram / console reports. */
export function formatInferenceCostLine(
  summary: InferenceCostSummary | undefined,
): string | undefined {
  if (!summary) {
    return undefined;
  }
  return `ZeroSignal inference: ${summary.requestCount} request(s), $${summary.totalUsdc} USDC`;
}

function collectZsHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const collected: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      if (key.toLowerCase().startsWith("x-zs-")) {
        collected[key.toLowerCase()] = value;
      }
    });
    return collected;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase().startsWith("x-zs-") && typeof value === "string") {
      collected[key.toLowerCase()] = value;
    }
  }
  return collected;
}

function lookupHeader(headers: Headers | Record<string, string>, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function parseUsdcAmount(raw: string): number | undefined {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function usdcToMicros(raw: string): bigint | undefined {
  const value = parseUsdcAmount(raw);
  if (value === undefined) return undefined;
  return BigInt(Math.round(value * 1_000_000));
}

function formatUsdc(value: number): string {
  const fixed = value.toFixed(6).replace(/\.?0+$/, "");
  return fixed === "" ? "0" : fixed;
}
