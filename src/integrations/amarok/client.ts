import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

import type { PaymentBuilder, PaymentReceipt } from "./payment.js";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listTools?(): Promise<McpToolDefinition[]>;
  close(): Promise<void>;
}

export class McpSdkToolCaller implements ToolCaller {
  private readonly client = new Client({
    name: "ghillie-bot",
    version: "1.0.0",
  });
  private connected = false;
  private connectPromise: Promise<void> | undefined;

  constructor(private readonly endpoint: URL) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureConnected();
    // Paid research (esp. amarok_get_scan) can exceed the SDK default 60s on a cold cache.
    return this.client.callTool({ name, arguments: args }, undefined, { timeout: 320_000 });
  }

  async listTools(): Promise<McpToolDefinition[]> {
    await this.ensureConnected();
    const result = await this.client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
      this.connectPromise = undefined;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (!this.connectPromise) {
      this.connectPromise = (async () => {
        const transport = new StreamableHTTPClientTransport(this.endpoint);
        await this.client.connect(transport);
        this.connected = true;
      })().catch((error) => {
        this.connectPromise = undefined;
        throw error;
      });
    }
    await this.connectPromise;
  }
}

const preflightSchema = z.object({
  error: z.literal("PAYMENT_REQUIRED"),
  mcpPayment: z.object({
    paymentRequired: z.unknown(),
    paymentRequiredHeader: z.string().optional(),
  }),
  request: z.unknown().optional(),
  retry: z.unknown().optional(),
});

export interface ManagedToolResult {
  data: unknown;
  payment?: PaymentReceipt;
}

const TOOL_RESOURCE_PATHS: Record<string, string | ((args: Record<string, unknown>) => string)> = {
  amarok_list_opportunities: "/v1/alpha/opportunities",
  amarok_list_rewards: "/v1/alpha/rewards",
  amarok_list_spreads: "/v1/alpha/spreads",
  amarok_list_parity: "/v1/alpha/parity",
  amarok_get_market: (args) => `/v1/alpha/markets/${String(args.marketAppId)}`,
  amarok_get_quotes: "/v1/alpha/quotes",
  amarok_get_scan: "/v1/alpha/scan",
  amarok_get_execution_quote: "/v1/alpha/execution/quotes",
  amarok_get_research_bundle: "/v1/alpha/bundle",
  amarok_create_research_session: "/v1/alpha/session",
};

/** Tools that accept host-owned `sessionToken` (Amarok research-get session class). */
const SESSION_COVERED_TOOLS = new Set([
  "amarok_list_opportunities",
  "amarok_list_rewards",
  "amarok_list_spreads",
  "amarok_list_parity",
  "amarok_get_market",
  "amarok_get_quotes",
  "amarok_get_research_bundle",
]);

export type ResearchSession = {
  token: string;
  expiresAt: string;
  ttlSeconds?: number;
};

export type LimitOrderQuoteInput = {
  marketAppId: number;
  outcome: "YES" | "NO";
  side: "bid" | "ask";
  price: number;
  sizeShares: number;
};

export class AmarokClient {
  private researchSession: ResearchSession | undefined;

  constructor(
    private readonly caller: ToolCaller,
    private readonly paymentBuilder: PaymentBuilder | undefined,
  ) {}

  setResearchSession(session: ResearchSession | undefined): void {
    this.researchSession = session;
  }

  clearResearchSession(): void {
    this.researchSession = undefined;
  }

  getResearchSession(): ResearchSession | undefined {
    return this.researchSession;
  }

  private liveSessionToken(): string | undefined {
    if (!this.researchSession?.token) return undefined;
    const expiresMs = Date.parse(this.researchSession.expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) {
      this.clearResearchSession();
      return undefined;
    }
    return this.researchSession.token;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    if (!this.caller.listTools) return [];
    return this.caller.listTools();
  }

  async callManagedTool(
    name: string,
    rawArgs: Record<string, unknown>,
    walletAddress: string,
  ): Promise<ManagedToolResult> {
    const args = injectManagedWallet(name, rawArgs, walletAddress);
    const sessionToken =
      SESSION_COVERED_TOOLS.has(name) && typeof args.sessionToken !== "string"
        ? this.liveSessionToken()
        : undefined;
    if (sessionToken) {
      args.sessionToken = sessionToken;
    }

    const preflight = parseToolPayload(await this.caller.callTool(name, args), name);
    const parsedPreflight = preflightSchema.safeParse(preflight);
    if (!parsedPreflight.success) {
      if (isToolError(preflight)) {
        throw new Error(formatToolError(preflight));
      }
      return { data: preflight };
    }

    // Invalid/expired session falls through to per-request 402 — clear and pay.
    if (args.sessionToken) {
      delete args.sessionToken;
      this.clearResearchSession();
    }

    if (!this.paymentBuilder) {
      throw new Error("Amarok payment is required but no local payment signer is configured");
    }
    assertManagedPaymentResource(name, parsedPreflight.data.mcpPayment.paymentRequired, args);
    const builtPayment = await this.paymentBuilder.build(
      parsedPreflight.data.mcpPayment.paymentRequired,
    );
    const paidPayload = parseToolPayload(
      await this.caller.callTool(name, {
        ...args,
        paymentSignature: builtPayment.paymentSignature,
      }),
      name,
    );
    if (isToolError(paidPayload)) {
      throw new Error(formatToolError(paidPayload));
    }
    const responseHeader = extractPaymentResponseHeader(paidPayload);
    return {
      data: paidPayload,
      payment: {
        ...builtPayment.receipt,
        responseHeader,
      },
    };
  }

  async health(): Promise<unknown> {
    return this.callFreeTool("amarok_health");
  }

  async getDiscovery(): Promise<unknown> {
    return this.callFreeTool("amarok_get_discovery");
  }

  async listExecutionShapes(): Promise<unknown> {
    return this.callFreeTool("amarok_list_execution_shapes");
  }

  private async callFreeTool(name: string): Promise<unknown> {
    const payload = parseToolPayload(await this.caller.callTool(name, {}), name);
    if (isToolError(payload)) {
      throw new Error(formatToolError(payload));
    }
    return payload;
  }

  async listOpportunities(
    walletAddress: string,
    args: Record<string, unknown> = {},
  ): Promise<ManagedToolResult> {
    return this.callManagedTool("amarok_list_opportunities", args, walletAddress);
  }

  async listRewards(
    walletAddress: string,
    args: Record<string, unknown> = {},
  ): Promise<ManagedToolResult> {
    return this.callManagedTool("amarok_list_rewards", args, walletAddress);
  }

  async listSpreads(
    walletAddress: string,
    args: Record<string, unknown> = {},
  ): Promise<ManagedToolResult> {
    return this.callManagedTool("amarok_list_spreads", args, walletAddress);
  }

  async listParity(
    walletAddress: string,
    args: Record<string, unknown> = {},
  ): Promise<ManagedToolResult> {
    return this.callManagedTool("amarok_list_parity", args, walletAddress);
  }

  async getMarket(walletAddress: string, marketAppId: number): Promise<ManagedToolResult> {
    return this.callManagedTool("amarok_get_market", { marketAppId }, walletAddress);
  }

  async getQuotes(
    walletAddress: string,
    args: Record<string, unknown> = {},
  ): Promise<ManagedToolResult> {
    return this.callManagedTool("amarok_get_quotes", args, walletAddress);
  }

  async getScan(
    walletAddress: string,
    args: Record<string, unknown> = {},
  ): Promise<ManagedToolResult> {
    return this.callManagedTool("amarok_get_scan", args, walletAddress);
  }

  async getResearchBundle(
    walletAddress: string,
    args: Record<string, unknown> = {},
  ): Promise<ManagedToolResult> {
    return this.callManagedTool("amarok_get_research_bundle", args, walletAddress);
  }

  async createResearchSession(
    walletAddress: string,
    args: Record<string, unknown> = {},
  ): Promise<ManagedToolResult> {
    const result = await this.callManagedTool("amarok_create_research_session", args, walletAddress);
    const session = extractResearchSession(result.data);
    if (session) {
      this.setResearchSession(session);
    }
    return result;
  }

  async getExecutionQuote(
    walletAddress: string,
    quotes: Array<{ shapeKey: string; input: LimitOrderQuoteInput & { agentAddress?: string } }>,
  ): Promise<ManagedToolResult> {
    return this.callManagedTool(
      "amarok_get_execution_quote",
      {
        agentAddress: walletAddress,
        quotes: quotes.map((quote) => ({
          shapeKey: quote.shapeKey,
          input: {
            ...quote.input,
            agentAddress: walletAddress,
          },
        })),
      },
      walletAddress,
    );
  }

  close(): Promise<void> {
    return this.caller.close();
  }
}

export function parseToolPayload(result: unknown, toolName?: string): unknown {
  const label = toolName ? `Amarok ${toolName}` : "Amarok MCP";
  if (!result || typeof result !== "object") {
    throw new Error(`${label} returned an invalid tool result`);
  }
  const record = result as Record<string, unknown>;
  const content = record.content;
  if (!Array.isArray(content)) {
    throw new Error(`${label} tool result has no content`);
  }
  const textParts = content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    return entry.type === "text" && typeof entry.text === "string" ? [entry.text] : [];
  });
  if (textParts.length === 0) {
    if (record.structuredContent !== undefined) {
      return record.structuredContent;
    }
    throw new Error(`${label} tool result has no text payload`);
  }
  const text = textParts.join("");
  const trimmed = text.trim();
  if (trimmed.startsWith("MCP error")) {
    throw new Error(`${label}: ${truncateErrorDetail(trimmed)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${label} returned invalid JSON (${reason}; length=${text.length}; preview=${truncateErrorDetail(text)})`,
    );
  }
}

function isToolError(payload: unknown): payload is {
  error: string;
  message?: string;
  details?: unknown;
} {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      typeof (payload as Record<string, unknown>).error === "string",
  );
}

function formatToolError(payload: {
  error: string;
  message?: string;
  details?: unknown;
  status?: unknown;
  bodySnippet?: unknown;
}): string {
  const base = payload.message
    ? `Amarok ${payload.error}: ${payload.message}`
    : `Amarok ${payload.error}`;
  const topLevelParts = [
    typeof payload.status === "number" ? `status=${payload.status}` : null,
    typeof payload.bodySnippet === "string"
      ? `body=${truncateErrorDetail(payload.bodySnippet)}`
      : null,
  ].filter(Boolean);
  if (payload.details === undefined || payload.details === null) {
    return topLevelParts.length > 0 ? `${base} (${topLevelParts.join(", ")})` : base;
  }
  if (typeof payload.details === "object") {
    try {
      return `${base} (details=${truncateErrorDetail(JSON.stringify(payload.details))})`;
    } catch {
      return base;
    }
  }
  return `${base} (details=${truncateErrorDetail(String(payload.details))})`;
}

function truncateErrorDetail(text: string, maxLength = 500): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

function injectManagedWallet(
  toolName: string,
  rawArgs: Record<string, unknown>,
  walletAddress: string,
): Record<string, unknown> {
  const args = structuredClone(rawArgs);
  if (toolName === "amarok_get_execution_quote") {
    args.agentAddress = walletAddress;
    const quotes = Array.isArray(args.quotes) ? args.quotes : [];
    args.quotes = quotes.map((item) => {
      const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const input =
        record.input && typeof record.input === "object"
          ? (record.input as Record<string, unknown>)
          : {};
      return {
        ...record,
        input: { ...input, agentAddress: walletAddress },
      };
    });
  }
  delete args.paymentSignature;
  delete args.sessionToken;
  return args;
}

function extractResearchSession(payload: unknown): ResearchSession | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as Record<string, unknown>;
  const session =
    root.session && typeof root.session === "object"
      ? (root.session as Record<string, unknown>)
      : root;
  const token = typeof session.token === "string" ? session.token : undefined;
  const expiresAt = typeof session.expiresAt === "string" ? session.expiresAt : undefined;
  if (!token || !expiresAt) return undefined;
  const ttlSeconds =
    typeof session.ttlSeconds === "number" && Number.isFinite(session.ttlSeconds)
      ? session.ttlSeconds
      : undefined;
  return { token, expiresAt, ttlSeconds };
}

function assertManagedPaymentResource(
  toolName: string,
  paymentRequired: unknown,
  args: Record<string, unknown>,
): void {
  if (!paymentRequired || typeof paymentRequired !== "object") {
    throw new Error("PAYMENT_REQUIRED is malformed");
  }
  const resource = (paymentRequired as Record<string, unknown>).resource;
  if (!resource || typeof resource !== "object") {
    throw new Error("PAYMENT_REQUIRED is missing resource");
  }
  const urlValue = (resource as Record<string, unknown>).url;
  if (typeof urlValue !== "string") {
    throw new Error("PAYMENT_REQUIRED is missing resource.url");
  }
  const url = new URL(urlValue);
  const pathSpec = TOOL_RESOURCE_PATHS[toolName];
  const expectedPath = typeof pathSpec === "function" ? pathSpec(args) : pathSpec;
  if (!expectedPath || url.pathname !== expectedPath) {
    throw new Error(
      `PAYMENT_REQUIRED resource path ${url.pathname} does not match MCP tool ${toolName} (expected ${expectedPath ?? "unknown"})`,
    );
  }
}

function extractPaymentResponseHeader(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const mcpPayment = (payload as Record<string, unknown>).mcpPayment;
  if (!mcpPayment || typeof mcpPayment !== "object") return undefined;
  const header = (mcpPayment as Record<string, unknown>).paymentResponseHeader;
  return typeof header === "string" ? header : undefined;
}
