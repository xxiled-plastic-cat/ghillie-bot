import { z } from "zod";

import {
  parseInferenceCostFromHeaders,
  type InferenceCostCharge,
} from "./inferenceCost.js";

const responseSchema = z
  .object({
    /** ZeroSignal may return an empty top-level id; treat as missing. */
    id: z.string().optional(),
    output: z.array(z.unknown()).default([]),
    output_text: z.string().optional(),
  })
  .passthrough();

export type NormalizedAgentResponse = {
  id?: string;
  output: unknown[];
  output_text?: string;
  raw: Record<string, unknown>;
};

export interface ResponsesClient {
  responses: {
    /**
     * Returns either the Responses body, or `{ data, response }` /
     * `{ data, headers }` so zs-proxy `X-Zs-*` cost headers can be read.
     */
    create(request: unknown): Promise<unknown>;
  };
}

const functionCallSchema = z.object({
  type: z.literal("function_call"),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
});

export type FunctionCallItem = z.infer<typeof functionCallSchema>;

/** Normalize Responses API payloads (including ZeroSignal empty `id`). */
export function normalizeAgentResponse(raw: unknown): NormalizedAgentResponse {
  const parsed = responseSchema.parse(raw);
  const id =
    typeof parsed.id === "string" && parsed.id.trim().length > 0 ? parsed.id : undefined;
  const output_text =
    parsed.output_text && parsed.output_text.length > 0
      ? parsed.output_text
      : extractOutputText(parsed.output);
  return {
    id,
    output: parsed.output,
    output_text,
    raw: parsed as Record<string, unknown>,
  };
}

/** Pull assistant `output_text` parts when the SDK does not set `output_text`. */
export function extractOutputText(output: unknown[]): string | undefined {
  const texts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type !== "message" || !Array.isArray(record.content)) continue;
    for (const part of record.content) {
      if (!part || typeof part !== "object") continue;
      const content = part as Record<string, unknown>;
      if (
        content.type === "output_text" &&
        typeof content.text === "string" &&
        content.text.length > 0
      ) {
        texts.push(content.text);
      }
    }
  }
  return texts.length > 0 ? texts.join("") : undefined;
}

export function extractFunctionCalls(output: unknown[]): FunctionCallItem[] {
  return output
    .map((item) => functionCallSchema.safeParse(item))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
}

/**
 * Build follow-up `input` by replaying the client-side transcript.
 * Never use `previous_response_id` with ZeroSignal.
 */
export function buildReplayInput(
  initialInput: string,
  conversationItems: unknown[],
  extraUserMessage?: string,
): unknown[] {
  const input: unknown[] = [{ role: "user", content: initialInput }, ...conversationItems];
  if (extraUserMessage !== undefined) {
    input.push({ role: "user", content: extraUserMessage });
  }
  return input;
}

/** Normalize OpenAI SDK / test mocks into body + optional HTTP headers. */
export async function createAgentResponse(
  openai: ResponsesClient,
  request: unknown,
): Promise<{ data: unknown; headers?: Headers }> {
  assertZsResponseRequest(request);
  const result = await openai.responses.create(request);
  if (!result || typeof result !== "object") {
    return { data: result };
  }
  const record = result as {
    data?: unknown;
    response?: { headers?: Headers };
    headers?: Headers | Record<string, string>;
  };
  if ("data" in record && record.data !== undefined) {
    if (record.response?.headers) {
      return { data: record.data, headers: record.response.headers };
    }
    if (record.headers) {
      return {
        data: record.data,
        headers:
          record.headers instanceof Headers
            ? record.headers
            : headersFromRecord(record.headers),
      };
    }
    return { data: record.data };
  }
  return { data: result };
}

export function recordInferenceCharge(
  charges: InferenceCostCharge[],
  headers: Headers | undefined,
): void {
  const charge = parseInferenceCostFromHeaders(headers);
  if (charge) {
    charges.push(charge);
  }
}

/**
 * Hard rules for every zs-proxy Responses call:
 * - `store: false`
 * - never `previous_response_id`
 */
export function assertZsResponseRequest(request: unknown): void {
  if (!request || typeof request !== "object") {
    throw new Error("ZeroSignal responses.create requires an object request body");
  }
  const record = request as Record<string, unknown>;
  if (record.store !== false) {
    throw new Error('ZeroSignal responses.create requires store: false');
  }
  if ("previous_response_id" in record && record.previous_response_id != null) {
    throw new Error(
      "ZeroSignal responses.create must not send previous_response_id; replay conversation client-side",
    );
  }
}

function headersFromRecord(record: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(record)) {
    headers.set(key, value);
  }
  return headers;
}
