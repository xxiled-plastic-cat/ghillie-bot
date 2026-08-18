import { z } from "zod";

import { type InferenceCostCharge, parseInferenceCostFromHeaders } from "./inferenceCost.js";

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
  const id = typeof parsed.id === "string" && parsed.id.trim().length > 0 ? parsed.id : undefined;
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

/** Force `stream: true` on every zs-proxy Responses request (brownie pattern). */
export function withStreamTrue(request: unknown): Record<string, unknown> {
  if (request !== null && typeof request === "object" && !Array.isArray(request)) {
    return { ...(request as Record<string, unknown>), stream: true };
  }
  return { stream: true, input: request };
}

/**
 * Drain a Responses SSE stream to the completed Response body.
 * zs-proxy / operator chains need streaming so idle read timeouts do not fire
 * while the model is still generating.
 */
export async function finalResponseFromStream(eventStream: unknown): Promise<unknown> {
  if (!isAsyncIterable(eventStream)) {
    return eventStream;
  }

  let completed: unknown;
  let failedMessage: string | undefined;

  for await (const event of eventStream) {
    if (!event || typeof event !== "object") {
      continue;
    }
    const record = event as Record<string, unknown>;
    if (record.type === "response.completed" && record.response !== undefined) {
      completed = record.response;
      continue;
    }
    if (record.type === "response.failed") {
      failedMessage = formatStreamFailure(record);
      continue;
    }
    if (record.type === "error") {
      failedMessage = formatStreamFailure(record);
    }
  }

  if (completed !== undefined) {
    return completed;
  }
  if (failedMessage) {
    throw new Error(`ZeroSignal stream failed: ${failedMessage}`);
  }
  throw new Error(
    "ZeroSignal stream ended without response.completed (enable stream: true end-to-end)",
  );
}

/** Normalize OpenAI SDK / test mocks into body + optional HTTP headers. */
export async function createAgentResponse(
  openai: ResponsesClient,
  request: unknown,
): Promise<{ data: unknown; headers?: Headers }> {
  assertZsResponseRequest(request);
  // stream: true is required for zs-proxy — see withStreamTrue / finalResponseFromStream.
  const result = await openai.responses.create(withStreamTrue(request));
  if (!result || typeof result !== "object") {
    return { data: await finalResponseFromStream(result) };
  }
  const record = result as {
    data?: unknown;
    response?: { headers?: Headers };
    headers?: Headers | Record<string, string>;
  };
  if ("data" in record && record.data !== undefined) {
    const data = await finalResponseFromStream(record.data);
    if (record.response?.headers) {
      return { data, headers: record.response.headers };
    }
    if (record.headers) {
      return {
        data,
        headers:
          record.headers instanceof Headers ? record.headers : headersFromRecord(record.headers),
      };
    }
    return { data };
  }
  return { data: await finalResponseFromStream(result) };
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
 * (`stream: true` is forced by withStreamTrue / createAgentResponse)
 */
export function assertZsResponseRequest(request: unknown): void {
  if (!request || typeof request !== "object") {
    throw new Error("ZeroSignal responses.create requires an object request body");
  }
  const record = request as Record<string, unknown>;
  if (record.store !== false) {
    throw new Error("ZeroSignal responses.create requires store: false");
  }
  if ("previous_response_id" in record && record.previous_response_id != null) {
    throw new Error(
      "ZeroSignal responses.create must not send previous_response_id; replay conversation client-side",
    );
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

function formatStreamFailure(record: Record<string, unknown>): string {
  const response = record.response;
  if (response && typeof response === "object") {
    const error = (response as { error?: unknown }).error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim().length > 0) {
        return message;
      }
    }
  }
  const message = record.message;
  if (typeof message === "string" && message.trim().length > 0) {
    return message;
  }
  return JSON.stringify(record);
}

function headersFromRecord(record: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(record)) {
    headers.set(key, value);
  }
  return headers;
}
