import type { McpToolDefinition } from "../amarok/client.js";

/** Research tools the model may call. Execution quote stays host-only. */
export const AGENT_RESEARCH_TOOL_ALLOWLIST = new Set([
  "amarok_list_opportunities",
  "amarok_list_rewards",
  "amarok_list_spreads",
  "amarok_list_parity",
  "amarok_get_market",
  "amarok_get_quotes",
  "amarok_get_scan",
]);

/** Host-only after policy approval. Never expose to the planning agent. */
export const HOST_ONLY_EXECUTION_TOOLS = new Set(["amarok_get_execution_quote"]);

export type SelectAgentResearchToolsOptions = {
  /** When `lane`, exclude mixed `amarok_list_opportunities`. Default: legacy. */
  researchMode?: "legacy" | "lane";
};

/**
 * Strip custody / payment fields from MCP tool schemas before showing them
 * to the model (brownie `prepareAgentTools` pattern).
 */
export function prepareAgentTools(tools: McpToolDefinition[]): McpToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    inputSchema: sanitizeToolSchema(tool.inputSchema),
  }));
}

export function selectAgentResearchTools(
  tools: McpToolDefinition[],
  options: SelectAgentResearchToolsOptions = {},
): McpToolDefinition[] {
  const researchMode = options.researchMode ?? "legacy";
  return prepareAgentTools(tools).filter((tool) => {
    if (HOST_ONLY_EXECUTION_TOOLS.has(tool.name)) return false;
    if (!AGENT_RESEARCH_TOOL_ALLOWLIST.has(tool.name)) return false;
    if (researchMode === "lane" && tool.name === "amarok_list_opportunities") return false;
    return true;
  });
}

export function toOpenAiFunctionTool(tool: McpToolDefinition) {
  return {
    type: "function" as const,
    name: tool.name,
    description: tool.description ?? `Call ${tool.name}`,
    strict: false,
    parameters: tool.inputSchema,
  };
}

function sanitizeToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(schema);
  sanitizeSchemaNode(clone);
  return clone;
}

function sanitizeSchemaNode(node: unknown): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (record.properties && typeof record.properties === "object") {
    const properties = record.properties as Record<string, unknown>;
    for (const key of [
      "paymentSignature",
      "address",
      "userAddress",
      "agentAddress",
      "walletAddress",
      "mnemonic",
    ]) {
      delete properties[key];
    }
    for (const value of Object.values(properties)) {
      sanitizeSchemaNode(value);
    }
  }
  if (Array.isArray(record.required)) {
    record.required = record.required.filter(
      (name) =>
        name !== "paymentSignature" &&
        name !== "address" &&
        name !== "userAddress" &&
        name !== "agentAddress" &&
        name !== "walletAddress" &&
        name !== "mnemonic",
    );
  }
  for (const keyword of ["items", "anyOf", "oneOf", "allOf"]) {
    const value = record[keyword];
    if (Array.isArray(value)) {
      value.forEach(sanitizeSchemaNode);
    } else {
      sanitizeSchemaNode(value);
    }
  }
}
