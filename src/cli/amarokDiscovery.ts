import dotenv from "dotenv";

import { McpSdkToolCaller, AmarokClient } from "../integrations/amarok/client.js";
import { printCliError } from "./amarokShared.js";

dotenv.config();

async function main(): Promise<void> {
  const mcpUrl = process.env.AMAROK_MCP_URL || "https://amarok-mcp.compx.io/mcp";
  const caller = new McpSdkToolCaller(new URL(mcpUrl));
  const client = new AmarokClient(caller, undefined);
  try {
    console.log(`MCP: ${mcpUrl}`);
    const [health, discovery, shapes] = await Promise.all([
      client.health(),
      client.getDiscovery(),
      client.listExecutionShapes(),
    ]);
    console.log("Amarok health:");
    console.log(JSON.stringify(health, null, 2));
    console.log("\nAmarok discovery (truncated):");
    console.log(JSON.stringify(discovery, null, 2).slice(0, 4_000));
    console.log("\nExecution shapes:");
    console.log(JSON.stringify(shapes, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  printCliError(error);
  process.exitCode = 1;
});
