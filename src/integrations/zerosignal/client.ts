import OpenAI from "openai";

import {
  readZeroSignalConfig,
  zsProxyHealthzUrl,
  type ZeroSignalConfig,
} from "./config.js";
import {
  createAgentResponse,
  type ResponsesClient,
} from "./responses.js";

export type ZeroSignalClient = {
  config: ZeroSignalConfig;
  openai: OpenAI;
  responses: ResponsesClient;
};

/**
 * OpenAI SDK pointed at zs-proxy. Admission is the wallet seal — the API key
 * is a non-empty placeholder only.
 */
export function createZeroSignalClient(
  environment: NodeJS.ProcessEnv = process.env,
): ZeroSignalClient {
  const config = readZeroSignalConfig(environment);
  const openai = new OpenAI({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl,
  });
  const responses: ResponsesClient = {
    responses: {
      async create(request: unknown) {
        const { data, response } = await openai.responses
          .create(request as never)
          .withResponse();
        return { data, response };
      },
    },
  };
  return { config, openai, responses };
}

/** Fail closed when zs-proxy is down or unpaid — no silent provider fallback. */
export async function assertZsProxyHealthy(
  openaiBaseUrl: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const healthz = zsProxyHealthzUrl(openaiBaseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(healthz, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(
        `zs-proxy unhealthy at ${healthz} (HTTP ${response.status}); refusing to call inference`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("zs-proxy unhealthy")) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `zs-proxy unreachable at ${healthz} (${detail}); refusing to call inference`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export { createAgentResponse };
