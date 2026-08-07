type TelegramNotifyOptions = {
  disableNotification?: boolean;
};

type TelegramThrottleOptions = TelegramNotifyOptions & {
  throttleMinutes: number;
};

export type TelegramRichReport = {
  rich: string;
  html: string;
  plain: string;
};

const PLAIN_REPORT_LIMIT = 4_000;
const RICH_REPORT_LIMIT = 32_000;
const HTML_REPORT_LIMIT = 4_000;

const throttleMemory = new Map<string, number>();

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

function readTelegramConfig(): { token?: string; chatId?: string; disabled: boolean } {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  const disabled = readBool(process.env.TELEGRAM_DISABLE_NOTIFICATIONS, false);
  return { token, chatId, disabled };
}

export function telegramEnabled(): boolean {
  const config = readTelegramConfig();
  return !config.disabled && Boolean(config.token) && Boolean(config.chatId);
}

export function readSkipNoticeThrottleMinutes(): number {
  const raw = process.env.ALPHA_TELEGRAM_SKIP_NOTICE_MINUTES?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 30;
  return parsed;
}

/** Escape dynamic free text so it cannot break Telegram Rich Markdown (GFM-like). */
export function escapeRichMarkdown(text: string): string {
  return [...text]
    .map((ch) => ("\\`*_[]()#|>~".includes(ch) ? `\\${ch}` : ch))
    .join("");
}

/** Escape dynamic text for Telegram HTML parse_mode. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function truncateTelegramText(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

export function truncateRichReport(value: string): string {
  return truncateTelegramText(value, RICH_REPORT_LIMIT);
}

export function truncateHtmlReport(value: string): string {
  return truncateTelegramText(value, HTML_REPORT_LIMIT);
}

export function truncatePlainReport(value: string): string {
  return truncateTelegramText(value, PLAIN_REPORT_LIMIT);
}

async function postTelegram(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
  };
  if (!response.ok || payload.ok === false) {
    throw new Error(
      `Telegram API ${method} failed (HTTP ${response.status})${
        payload.description ? `: ${payload.description}` : ""
      }`,
    );
  }
}

export async function notifyTelegram(text: string, options: TelegramNotifyOptions = {}): Promise<boolean> {
  const { token, chatId, disabled } = readTelegramConfig();
  if (disabled || !token || !chatId) return false;

  try {
    await postTelegram(token, "sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      disable_notification: options.disableNotification ?? false,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Telegram notify failed: ${message}`);
    return false;
  }
}

/**
 * Prefer rich markdown (`sendRichMessage`), then HTML `sendMessage`, then plain text.
 * Mirrors brownie-bot delivery so tables / headings / details render when supported.
 */
export async function notifyTelegramReport(
  report: TelegramRichReport,
  options: TelegramNotifyOptions = {},
): Promise<boolean> {
  const { token, chatId, disabled } = readTelegramConfig();
  if (disabled || !token || !chatId) return false;

  const disableNotification = options.disableNotification ?? false;

  try {
    await postTelegram(token, "sendRichMessage", {
      chat_id: chatId,
      rich_message: { markdown: report.rich },
      disable_notification: disableNotification,
    });
    return true;
  } catch (richError) {
    const richMessage = richError instanceof Error ? richError.message : String(richError);
    console.error(`Telegram sendRichMessage failed; falling back to HTML: ${richMessage}`);
  }

  try {
    await postTelegram(token, "sendMessage", {
      chat_id: chatId,
      text: report.html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      disable_notification: disableNotification,
    });
    return true;
  } catch (htmlError) {
    const htmlMessage = htmlError instanceof Error ? htmlError.message : String(htmlError);
    console.error(`Telegram HTML sendMessage failed; falling back to plain: ${htmlMessage}`);
  }

  try {
    await postTelegram(token, "sendMessage", {
      chat_id: chatId,
      text: report.plain,
      disable_web_page_preview: true,
      disable_notification: disableNotification,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Telegram plain notify failed: ${message}`);
    return false;
  }
}

export async function notifyTelegramThrottled(
  throttleKey: string,
  text: string,
  options: TelegramThrottleOptions,
): Promise<boolean> {
  const now = Date.now();
  const previous = throttleMemory.get(throttleKey);
  const throttleMs = options.throttleMinutes * 60_000;
  if (previous !== undefined && now - previous < throttleMs) return false;
  const sent = await notifyTelegram(text, options);
  if (sent) throttleMemory.set(throttleKey, now);
  return sent;
}
