/**
 * Inbound Telegram slash-command loop (Brownie-style).
 * Outbound digests stay on telegramNotifier.ts.
 */

import { readAlphaConfig } from "./alphaConfig.js";
import {
  clearLaneOverride,
  formatLaneStatusLines,
  getLaneOverrides,
  type LaneOverrides,
  parseLaneName,
  setLaneOverride,
} from "./laneOverrideStore.js";
import type { TelegramBotClient, TelegramUpdate } from "./telegramBotClient.js";
import { telegramEnabled } from "./telegramNotifier.js";
import { formatDailySpendLines, loadX402SpendReport, type X402SpendReport } from "./x402Spend.js";

export interface ParsedTelegramCommand {
  name: string;
  args: string;
  raw: string;
}

export interface TelegramCommandContext {
  chatId: string;
  command: ParsedTelegramCommand;
  /** Send an extra message (e.g. completion follow-up after an immediate start ack). */
  reply: (text: string) => Promise<void>;
}

export type TelegramCommandHandler = (ctx: TelegramCommandContext) => Promise<string>;

export interface TelegramCommandLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export const HELP_TEXT = [
  "Ghillie operator commands:",
  "/help — list commands",
  "/status — cron health, lanes, Amarok x402 spend",
  "/lanes — compact lane on/off status",
  "/lane <reward|spread|parity> <on|off|default> — toggle a lane (next tick)",
].join("\n");

/**
 * Parse `/cmd@BotName args` into a normalized command name (lowercase, no @bot).
 * Returns undefined when the text is not a slash command.
 */
export function parseTelegramCommand(text: string | undefined): ParsedTelegramCommand | undefined {
  if (!text) {
    return undefined;
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const [rawToken, ...rest] = trimmed.split(/\s+/);
  const token = rawToken ?? "";
  const withoutSlash = token.slice(1);
  const at = withoutSlash.indexOf("@");
  const name = (at >= 0 ? withoutSlash.slice(0, at) : withoutSlash).toLowerCase();
  if (!name) {
    return undefined;
  }
  return {
    name,
    args: rest.join(" ").trim(),
    raw: trimmed,
  };
}

export function isAllowedTelegramChat(chatId: string | number, allowedChatId: string): boolean {
  return String(chatId) === String(allowedChatId);
}

export function createCommandDispatcher(
  handlers: Record<string, TelegramCommandHandler>,
  helpText: string = HELP_TEXT,
): TelegramCommandHandler {
  return async (ctx) => {
    const handler = handlers[ctx.command.name];
    if (!handler) {
      return `Unknown command /${ctx.command.name}.\n${helpText}`;
    }
    return handler(ctx);
  };
}

export type CronHealthSnapshot = {
  running: boolean;
  schedule: string;
  command: string;
  lastTickStartedAt?: string;
  lastTickEndedAt?: string;
  lastTickExitCode?: number;
};

export interface LaneCommandDeps {
  getCronHealth: () => CronHealthSnapshot;
  getOverrides?: () => Promise<LaneOverrides>;
  getX402Spend?: () => Promise<X402SpendReport>;
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

export function formatLanesReply(base = readAlphaConfig(), overrides: LaneOverrides): string {
  return ["Lane status (effective on next tick):", ...formatLaneStatusLines(base, overrides)].join(
    "\n",
  );
}

export function formatStatusReply(
  health: CronHealthSnapshot,
  overrides: LaneOverrides,
  base = readAlphaConfig(),
  spend?: X402SpendReport,
): string {
  const lines = [
    "Ghillie alpha status",
    `cron_busy: ${health.running ? "yes" : "no"}`,
    `schedule: ${health.schedule}`,
    `command: ${health.command}`,
    `last_tick_started: ${health.lastTickStartedAt ?? "never"}`,
    `last_tick_ended: ${health.lastTickEndedAt ?? "never"}`,
    `last_tick_exit: ${health.lastTickExitCode ?? "n/a"}`,
    "",
    ...formatLaneStatusLines(base, overrides),
  ];
  if (overrides.updatedAt) {
    lines.push(`overrides_updated: ${overrides.updatedAt} (${overrides.source ?? "unknown"})`);
  }
  if (spend) {
    lines.push("", ...formatDailySpendLines(spend));
  }
  return lines.join("\n");
}

export function createLaneCommandHandlers(
  deps: LaneCommandDeps,
): Record<string, TelegramCommandHandler> {
  const loadOverrides = deps.getOverrides ?? getLaneOverrides;

  const help: TelegramCommandHandler = async () => HELP_TEXT;

  const status: TelegramCommandHandler = async () => {
    const overrides = await loadOverrides();
    const base = readAlphaConfig();
    const spend = await (deps.getX402Spend ?? (() => loadX402SpendReport(base)))();
    return formatStatusReply(deps.getCronHealth(), overrides, base, spend);
  };

  const lanes: TelegramCommandHandler = async () => {
    const overrides = await loadOverrides();
    return formatLanesReply(readAlphaConfig(), overrides);
  };

  const lane: TelegramCommandHandler = async (ctx) => {
    const parts = ctx.command.args.split(/\s+/).filter(Boolean);
    if (parts.length !== 2) {
      throw new Error("Usage: /lane <reward|spread|parity> <on|off|default>");
    }
    const laneName = parseLaneName(parts[0] ?? "");
    if (!laneName) {
      throw new Error(`Unknown lane "${parts[0]}". Use reward, spread, or parity.`);
    }
    const action = (parts[1] ?? "").toLowerCase();
    let overrides: LaneOverrides;
    if (action === "on" || action === "off") {
      overrides = await setLaneOverride(laneName, action === "on", "telegram");
    } else if (action === "default") {
      overrides = await clearLaneOverride(laneName, "telegram");
    } else {
      throw new Error(`Unknown action "${parts[1]}". Use on, off, or default.`);
    }
    const base = readAlphaConfig();
    const effective =
      laneName === "reward"
        ? (overrides.reward ?? base.enableRewardLane)
        : laneName === "spread"
          ? (overrides.spread ?? base.enableSpreadLane)
          : (overrides.parity ?? base.enableParityLane);
    const overrideLabel =
      overrides[laneName] === undefined ? "env default" : `override ${onOff(overrides[laneName]!)}`;
    return [
      `Lane ${laneName} → ${onOff(effective)} (${overrideLabel}).`,
      "Takes effect on the next cron tick.",
      "",
      formatLanesReply(base, overrides),
    ].join("\n");
  };

  return {
    help,
    start: help,
    status,
    lanes,
    lane,
  };
}

export interface TelegramCommandLoopOptions {
  client: TelegramBotClient;
  allowedChatId: string;
  dispatch: TelegramCommandHandler;
  logger?: TelegramCommandLogger;
  /** Long-poll timeout in seconds (Telegram max 50). */
  pollTimeoutSeconds?: number;
  /** Backoff after transient getUpdates failures. */
  errorBackoffMs?: number;
}

/**
 * Long-polls Telegram getUpdates and dispatches slash commands from the
 * configured chat. Drains pending updates on start so redeploys do not replay
 * stale commands.
 */
export class TelegramCommandLoop {
  private readonly client: TelegramBotClient;
  private readonly allowedChatId: string;
  private readonly dispatch: TelegramCommandHandler;
  private readonly logger: TelegramCommandLogger;
  private readonly pollTimeoutSeconds: number;
  private readonly errorBackoffMs: number;
  private offset = 0;
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private abort: AbortController | undefined;

  constructor(options: TelegramCommandLoopOptions) {
    this.client = options.client;
    this.allowedChatId = options.allowedChatId;
    this.dispatch = options.dispatch;
    this.logger = options.logger ?? silentLogger;
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 25;
    this.errorBackoffMs = options.errorBackoffMs ?? 3_000;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.abort?.abort();
    await this.loopPromise?.catch(() => undefined);
    this.loopPromise = undefined;
    this.abort = undefined;
  }

  /** Process a single update (exported for tests). */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    this.offset = Math.max(this.offset, update.update_id + 1);
    const message = update.message;
    if (!message?.text) {
      return;
    }
    const chatId = String(message.chat.id);
    if (!isAllowedTelegramChat(chatId, this.allowedChatId)) {
      this.logger.warn({ chatId }, "telegram command ignored (chat ACL)");
      return;
    }
    const command = parseTelegramCommand(message.text);
    if (!command) {
      return;
    }

    try {
      const reply = async (text: string) => {
        await this.client.sendText(chatId, truncateReply(text));
      };
      const messageText = await this.dispatch({ chatId, command, reply });
      await reply(messageText);
    } catch (error) {
      const text = errorMessage(error);
      this.logger.error({ err: text, command: command.name }, "telegram command failed");
      try {
        await this.client.sendText(
          chatId,
          truncateReply(`Command /${command.name} failed: ${text}`),
        );
      } catch (sendError) {
        this.logger.error({ err: errorMessage(sendError) }, "telegram command error reply failed");
      }
    }
  }

  private async runLoop(): Promise<void> {
    try {
      await this.drainPendingUpdates();
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      this.logger.warn({ err: errorMessage(error) }, "telegram command drain failed; continuing");
    }

    while (this.running) {
      try {
        const updates = await this.client.getUpdates({
          offset: this.offset,
          timeout: this.pollTimeoutSeconds,
          allowed_updates: ["message"],
          signal: this.abort?.signal,
        });
        for (const update of updates) {
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (!this.running || isAbortError(error)) {
          return;
        }
        this.logger.warn({ err: errorMessage(error) }, "telegram getUpdates failed; backing off");
        await sleep(this.errorBackoffMs, this.abort?.signal);
      }
    }
  }

  private async drainPendingUpdates(): Promise<void> {
    const updates = await this.client.getUpdates({
      offset: this.offset,
      timeout: 0,
      allowed_updates: ["message"],
      signal: this.abort?.signal,
    });
    for (const update of updates) {
      this.offset = Math.max(this.offset, update.update_id + 1);
    }
    if (updates.length > 0) {
      this.logger.info(
        { drained: updates.length, offset: this.offset },
        "drained stale telegram updates on boot",
      );
    }
  }
}

export function startTelegramCommandLoop(options: TelegramCommandLoopOptions): TelegramCommandLoop {
  const loop = new TelegramCommandLoop(options);
  loop.start();
  return loop;
}

export function readTelegramCommandCredentials(
  env: NodeJS.ProcessEnv = process.env,
): { token: string; chatId: string } | undefined {
  if (!telegramEnabled()) return undefined;
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return undefined;
  return { token, chatId };
}

function truncateReply(text: string, max = 3_500): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name: string }).name === "AbortError")
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const silentLogger: TelegramCommandLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export const consoleTelegramLogger: TelegramCommandLogger = {
  info: (obj, msg) => console.log(`[telegram-commands] ${msg}`, obj),
  warn: (obj, msg) => console.warn(`[telegram-commands] ${msg}`, obj),
  error: (obj, msg) => console.error(`[telegram-commands] ${msg}`, obj),
};
