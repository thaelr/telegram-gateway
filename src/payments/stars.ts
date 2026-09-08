import { config } from "../config.js";

export type CreateStarsInvoiceInput = {
  title: string;
  description: string;
  payload: string;
  label: string;
  amount_xtr: number;
};

export type CreateStarsInvoiceResult = {
  invoice_link: string;
};

export interface StarsInvoiceClient {
  createStarsInvoice(
    input: CreateStarsInvoiceInput,
  ): Promise<CreateStarsInvoiceResult>;
}

type TelegramApiErrorPayload = {
  ok?: unknown;
  description?: unknown;
  error_code?: unknown;
  result?: unknown;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function toTelegramApiPayload(value: unknown): TelegramApiErrorPayload | null {
  return isObjectRecord(value) ? (value as TelegramApiErrorPayload) : null;
}

function toDescription(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function toStatusCode(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export class TelegramStarsInvoiceError extends Error {
  readonly code = "stars_invoice_creation_failed";

  constructor(
    message: string,
    readonly stage: "request" | "response",
    readonly statusCode: number | null,
    readonly description: string | null,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TelegramStarsInvoiceError";
  }
}

export class TelegramStarsPaymentAdapter implements StarsInvoiceClient {
  async createStarsInvoice(
    input: CreateStarsInvoiceInput,
  ): Promise<CreateStarsInvoiceResult> {
    let response: Response;

    try {
      response = await fetch(
        `https://api.telegram.org/bot${config.TG_BOT_TOKEN}/createInvoiceLink`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            title: input.title,
            description: input.description,
            payload: input.payload,
            currency: "XTR",
            prices: [{
              label: input.label,
              amount: input.amount_xtr,
            }],
            provider_token: "",
          }),
        },
      );
    } catch (error) {
      throw new TelegramStarsInvoiceError(
        "Telegram Stars request failed",
        "request",
        null,
        error instanceof Error ? error.message : null,
        undefined,
        { cause: error instanceof Error ? error : undefined },
      );
    }

    const rawBody = await response.text();
    let parsedBody: unknown = null;

    if (rawBody.length > 0) {
      try {
        parsedBody = JSON.parse(rawBody) as unknown;
      } catch (error) {
        throw new TelegramStarsInvoiceError(
          "Telegram Stars response is not valid JSON",
          "response",
          response.status,
          null,
          rawBody,
          { cause: error instanceof Error ? error : undefined },
        );
      }
    }

    const payload = toTelegramApiPayload(parsedBody);
    const description = toDescription(payload?.description);
    const errorCode = toStatusCode(payload?.error_code);

    if (!response.ok) {
      throw new TelegramStarsInvoiceError(
        "Telegram Stars API returned a non-success HTTP status",
        "response",
        response.status,
        description,
        payload ?? rawBody,
      );
    }

    if (payload?.ok !== true) {
      throw new TelegramStarsInvoiceError(
        "Telegram Stars API returned ok !== true",
        "response",
        errorCode ?? response.status,
        description,
        payload ?? rawBody,
      );
    }

    const invoiceLink = toDescription(payload.result);
    if (!invoiceLink) {
      throw new TelegramStarsInvoiceError(
        "Telegram Stars API returned an empty invoice link",
        "response",
        response.status,
        description,
        payload ?? rawBody,
      );
    }

    return { invoice_link: invoiceLink };
  }
}
