export type ZeroSignalAiMode = "full" | "lite";

export type ZeroSignalReasoningEffort = "low" | "medium" | "high";

export type ZeroSignalConfig = {
  /** OpenAI-compatible base URL (zs-proxy `/v1`). */
  openaiBaseUrl: string;
  /**
   * Placeholder for the OpenAI SDK (requires a non-empty string).
   * zs-proxy ignores the key; admission is the on-chain wallet seal.
   */
  openaiApiKey: string;
  openaiModel: string;
  openaiReasoningEffort: ZeroSignalReasoningEffort;
  /**
   * `full` — LLM drives Amarok research via a multi-turn tool loop.
   * `lite` — host prefetches research; LLM decides once with tools disabled.
   */
  aiMode: ZeroSignalAiMode;
  /** Caps MCP tool calls per review in full mode only. */
  aiMaxToolCalls: number;
};

function readOptionalString(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = environment[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw.trim();
}

function readInt(environment: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = environment[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readReasoningEffort(
  environment: NodeJS.ProcessEnv,
  fallback: ZeroSignalReasoningEffort,
): ZeroSignalReasoningEffort {
  const raw = environment.OPENAI_REASONING_EFFORT?.toLowerCase();
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  return fallback;
}

function readAiMode(environment: NodeJS.ProcessEnv, fallback: ZeroSignalAiMode): ZeroSignalAiMode {
  const raw = environment.AI_MODE?.toLowerCase();
  if (raw === "full" || raw === "lite") return raw;
  return fallback;
}

/** Load ZeroSignal / zs-proxy client settings from env (fail-closed defaults to local proxy). */
export function readZeroSignalConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ZeroSignalConfig {
  return {
    openaiBaseUrl: readOptionalString(environment, "OPENAI_BASE_URL") ?? "http://127.0.0.1:8080/v1",
    openaiApiKey: readOptionalString(environment, "OPEN_AI_API_KEY") ?? "zerosignal",
    openaiModel: readOptionalString(environment, "OPENAI_MODEL") ?? "glm-5.2",
    openaiReasoningEffort: readReasoningEffort(environment, "medium"),
    aiMode: readAiMode(environment, "full"),
    aiMaxToolCalls: Math.min(50, Math.max(3, readInt(environment, "AI_MAX_TOOL_CALLS", 16))),
  };
}

/** Map `OPENAI_BASE_URL` (`…/v1`) to zs-proxy `/healthz`. */
export function zsProxyHealthzUrl(openaiBaseUrl: string): string {
  const url = new URL(openaiBaseUrl);
  url.pathname = "/healthz";
  url.search = "";
  url.hash = "";
  return url.toString();
}
