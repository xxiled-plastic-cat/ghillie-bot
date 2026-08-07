import { spawn } from "node:child_process";
import { createServer } from "node:http";

import cron from "node-cron";
import dotenv from "dotenv";
import { notifyTelegram, notifyTelegramThrottled, readSkipNoticeThrottleMinutes } from "./telegramNotifier.js";
import { isDebugModeEnabled } from "../utils/debugMode.js";

dotenv.config();

const schedule = process.env.ALPHA_CRON_SCHEDULE || "*/2 * * * *";
const command = process.env.ALPHA_CRON_COMMAND || "npm run alpha:live";
const once = process.argv.includes("--once");
const healthPort = Number.parseInt(process.env.PORT || process.env.ALPHA_HEALTH_PORT || "", 10);
const skipNoticeThrottleMinutes = readSkipNoticeThrottleMinutes();
let running = false;
let lastTickStartedAt: string | undefined;
let lastTickEndedAt: string | undefined;
let lastTickExitCode: number | undefined;

function logStartupDebug(message: string): void {
  if (!isDebugModeEnabled()) return;
  console.log(`[startup-debug ${new Date().toISOString()}] [cron] ${message}`);
}

function runTick(): Promise<number> {
  return new Promise((resolve) => {
    const tickStarted = Date.now();
    logStartupDebug(`runTick spawn start command="${command}" cwd=${process.cwd()}`);
    const child = spawn(command, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: true,
      env: process.env,
    });
    logStartupDebug(`runTick child spawned pid=${child.pid ?? -1}`);
    child.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logStartupDebug(`runTick child error message=${message}`);
    });
    child.on("close", (code, signal) => {
      logStartupDebug(
        `runTick child close code=${code ?? "null"} signal=${signal ?? "none"} elapsed_ms=${Date.now() - tickStarted}`,
      );
      resolve(code ?? 1);
    });
  });
}

function startHealthServer(): void {
  if (!Number.isFinite(healthPort)) return;
  const server = createServer((request, response) => {
    const path = request.url?.split("?")[0] ?? "/";
    if (path !== "/" && path !== "/health" && path !== "/healthz" && path !== "/ready") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        service: "ghillie-alpha-cron",
        schedule,
        command,
        running,
        lastTickStartedAt,
        lastTickEndedAt,
        lastTickExitCode,
      }),
    );
  });
  server.listen(healthPort, "0.0.0.0", () => {
    console.log(`Health server listening on 0.0.0.0:${healthPort}`);
  });
}

async function main(): Promise<void> {
  logStartupDebug(
    `main start pid=${process.pid} cwd=${process.cwd()} schedule=${schedule} command="${command}" once=${once} port=${Number.isFinite(healthPort) ? healthPort : "none"}`,
  );
  if (once) {
    logStartupDebug("main running in --once mode");
    const code = await runTick();
    process.exitCode = code;
    logStartupDebug(`main --once completed exitCode=${code}`);
    return;
  }
  if (!cron.validate(schedule)) {
    throw new Error(`Invalid ALPHA_CRON_SCHEDULE: ${schedule}`);
  }
  console.log(`GHILLIE ALPHA CRON`);
  console.log(`Schedule: ${schedule}`);
  console.log(`Command: ${command}`);
  await notifyTelegram(`Ghillie alpha cron started\nschedule=${schedule}\ncommand=${command}`);
  startHealthServer();
  cron.schedule(schedule, async () => {
    if (running) {
      const skippedAt = new Date().toISOString();
      console.log(`[${skippedAt}] previous tick still running; skipping this schedule`);
      await notifyTelegramThrottled(
        "alpha-cron-overlap-skip",
        `Ghillie cron overlap skip\nat=${skippedAt}\nprevious_tick_started_at=${lastTickStartedAt ?? "unknown"}`,
        { throttleMinutes: skipNoticeThrottleMinutes },
      );
      return;
    }
    running = true;
    lastTickStartedAt = new Date().toISOString();
    logStartupDebug(`tick scheduled start at=${lastTickStartedAt}`);
    console.log(`[${lastTickStartedAt}] cron tick start`);
    const exitCode = await runTick();
    lastTickEndedAt = new Date().toISOString();
    lastTickExitCode = exitCode;
    logStartupDebug(`tick scheduled end at=${lastTickEndedAt} exitCode=${exitCode}`);
    console.log(`[${lastTickEndedAt}] cron tick end exit_code=${exitCode}`);
    if (exitCode !== 0) {
      await notifyTelegram(`ALERT: Ghillie cron tick failed\nat=${lastTickEndedAt}\nexit_code=${exitCode}`);
    }
    running = false;
  });
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logStartupDebug(`main failed message=${message}`);
  console.error(message);
  process.exitCode = 1;
});
