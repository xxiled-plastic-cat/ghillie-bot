import type { ServerResponse } from "node:http";
import { createServer } from "node:http";
import dotenv from "dotenv";

import { buildAlphaDashboardSnapshot } from "./alphaDashboardData.js";

dotenv.config();

const port = Number.parseInt(process.env.ALPHA_DASHBOARD_PORT || process.env.PORT || "8787", 10);
const host = process.env.ALPHA_DASHBOARD_HOST || "127.0.0.1";

function withCorsHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    ...headers,
  };
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(
    status,
    withCorsHeaders({ "content-type": "application/json; charset=utf-8" }),
  );
  response.end(JSON.stringify(payload));
}

async function main(): Promise<void> {
  const server = createServer(async (request, response) => {
    if (!request.url) {
      sendJson(response, 400, { ok: false, error: "missing_url" });
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, withCorsHeaders());
      response.end();
      return;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }

    const requestUrl = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
    const path = requestUrl.pathname;
    const wallet = requestUrl.searchParams.get("wallet") ?? undefined;

    if (path === "/" || path === "/health" || path === "/healthz" || path === "/api/alpha/health") {
      sendJson(response, 200, {
        ok: true,
        service: "ghillie-alpha-dashboard-api",
        now: new Date().toISOString(),
      });
      return;
    }

    if (
      path !== "/api/alpha/dashboard" &&
      path !== "/api/alpha/overview" &&
      path !== "/api/alpha/positions" &&
      path !== "/api/alpha/orders"
    ) {
      sendJson(response, 404, { ok: false, error: "not_found" });
      return;
    }

    try {
      const snapshot = await buildAlphaDashboardSnapshot(wallet);
      if (path === "/api/alpha/dashboard") {
        sendJson(response, 200, { ok: true, data: snapshot });
        return;
      }
      if (path === "/api/alpha/overview") {
        sendJson(response, 200, {
          ok: true,
          data: {
            asOf: snapshot.asOf,
            stateLastUpdated: snapshot.health.stateLastUpdated,
            walletAddress: snapshot.walletAddress,
            walletBalances: snapshot.walletBalances,
            overview: snapshot.overview,
            errors: snapshot.health.errors,
          },
        });
        return;
      }
      if (path === "/api/alpha/positions") {
        sendJson(response, 200, {
          ok: true,
          data: {
            asOf: snapshot.asOf,
            walletAddress: snapshot.walletAddress,
            positions: snapshot.positions,
            errors: snapshot.health.errors,
          },
        });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        data: {
          asOf: snapshot.asOf,
          walletAddress: snapshot.walletAddress,
          openOrders: snapshot.openOrders,
          activity: snapshot.activity,
          errors: snapshot.health.errors,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { ok: false, error: message });
    }
  });

  server.listen(port, host, () => {
    console.log(`Alpha dashboard API listening on http://${host}:${port}`);
  });

  const shutdown = async () => {
    server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
