import { config } from "./config.js";
import { normalizePositiveInteger } from "./numeric.js";

export const TELEGRAM_UX_TIMEOUT_MS = 5_000;

type TelegramResult = Record<string, unknown> | Array<Record<string, unknown>> | true;

export class TelegramUxRequestError extends Error {
  constructor(
    message: string,
    readonly outcome: "definitive_failure" | "uncertain",
    readonly method: string,
    readonly statusCode: number | null,
    readonly description: string | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TelegramUxRequestError";
  }
}

export interface TelegramNavigationTransport {
  answerCallbackQuery(callbackQueryId: string): Promise<void>;
  sendMessage(input: Record<string, unknown>): Promise<number>;
  sendPhoto(input: Record<string, unknown>): Promise<number>;
  sendMediaGroup(input: Record<string, unknown>): Promise<number[]>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
}

function descriptionFrom(value: unknown): string | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const description = (value as Record<string, unknown>).description;
  return typeof description === "string" && description.trim()
    ? description.trim()
    : null;
}

function messageIdFrom(value: unknown): number {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new Error("Telegram response is missing a message object");
  }
  const messageId = normalizePositiveInteger(
    (value as Record<string, unknown>).message_id,
  );
  if (messageId == null) throw new Error("Telegram response has an invalid message_id");
  return messageId;
}

export class TelegramBotClient implements TelegramNavigationTransport {
  constructor(
    private readonly timeoutMs = TELEGRAM_UX_TIMEOUT_MS,
    private readonly apiBaseUrl = `https://api.telegram.org/bot${config.TG_BOT_TOKEN}`,
  ) {}

  private async request(method: string, body: Record<string, unknown>): Promise<TelegramResult> {
    let response: Response;
    try {
      response = await fetch(`${this.apiBaseUrl}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new TelegramUxRequestError(
        `Telegram ${method} result is unknown`,
        "uncertain",
        method,
        null,
        error instanceof Error ? error.message : null,
        { cause: error instanceof Error ? error : undefined },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new TelegramUxRequestError(
        `Telegram ${method} returned invalid JSON`,
        "definitive_failure",
        method,
        response.status,
        null,
        { cause: error instanceof Error ? error : undefined },
      );
    }

    const record = typeof payload === "object" && payload != null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
    if (!response.ok || record?.ok !== true) {
      throw new TelegramUxRequestError(
        `Telegram ${method} failed`,
        "definitive_failure",
        method,
        response.status,
        descriptionFrom(payload),
      );
    }
    const result = record.result;
    if (result === true || Array.isArray(result) || (typeof result === "object" && result != null)) {
      return result as TelegramResult;
    }
    throw new TelegramUxRequestError(
      `Telegram ${method} returned an invalid result`,
      "definitive_failure",
      method,
      response.status,
      null,
    );
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    await this.request("answerCallbackQuery", { callback_query_id: callbackQueryId });
  }

  async sendMessage(input: Record<string, unknown>): Promise<number> {
    return messageIdFrom(await this.request("sendMessage", input));
  }

  async sendPhoto(input: Record<string, unknown>): Promise<number> {
    return messageIdFrom(await this.request("sendPhoto", input));
  }

  async sendMediaGroup(input: Record<string, unknown>): Promise<number[]> {
    const result = await this.request("sendMediaGroup", input);
    if (!Array.isArray(result)) {
      throw new TelegramUxRequestError(
        "Telegram sendMediaGroup returned an invalid result",
        "definitive_failure",
        "sendMediaGroup",
        null,
        null,
      );
    }
    return result.map(messageIdFrom);
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.request("deleteMessage", { chat_id: chatId, message_id: messageId });
  }
}
