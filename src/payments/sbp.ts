import { config } from "../config.js";

export type CreateSbpPaymentInput = {
  token: string;
  chat_id: number;
  description: string;
  amount_rub: number;
  metadata?: Record<string, unknown>;
};

export type CreateSbpPaymentResult = {
  external_payment_id: string;
  checkout_url: string;
  provider_expires_at: string | null;
};

export type SbpTransactionStatus =
  | "CANCELED"
  | "PENDING"
  | "CONFIRMED"
  | "CHARGEBACKED";

export interface SbpPaymentClient {
  createPayment(
    input: CreateSbpPaymentInput,
  ): Promise<CreateSbpPaymentResult>;
  getTransactionStatus?(
    externalPaymentId: string,
  ): Promise<SbpTransactionStatus | null>;
}

type SbpApiPayload = {
  transactionId?: unknown;
  redirect?: unknown;
  expiresIn?: unknown;
  status?: unknown;
  error?: unknown;
  message?: unknown;
};

export const SBP_PAYMENT_REQUEST_TIMEOUT_MS = 20_000;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseExpiresIn(value: unknown): string | null {
  const raw = normalizeText(value);
  if (!raw) return null;
  const match = /^(\d{2,}):([0-5]\d):([0-5]\d)$/u.exec(raw);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const durationMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) return null;

  return new Date(Date.now() + durationMs).toISOString();
}

function normalizeTransactionStatus(value: unknown): SbpTransactionStatus | null {
  const status = normalizeText(value)?.toUpperCase();
  return status === "CANCELED"
    || status === "PENDING"
    || status === "CONFIRMED"
    || status === "CHARGEBACKED"
    ? status
    : null;
}

export class SbpPaymentError extends Error {
  readonly code = "sbp_payment_creation_failed";

  constructor(
    message: string,
    readonly stage: "request" | "response",
    readonly statusCode: number | null,
    readonly outcome: "definite_failure" | "ambiguous",
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SbpPaymentError";
  }
}

export class SbpPaymentAdapter implements SbpPaymentClient {
  async createPayment(
    input: CreateSbpPaymentInput,
  ): Promise<CreateSbpPaymentResult> {
    if (!config.SBP_ENABLED) {
      throw new SbpPaymentError(
        "SBP adapter is disabled",
        "request",
        null,
        "definite_failure",
      );
    }

    let response: Response;

    try {
      response = await fetch(`${config.SBP_API_BASE_URL}/transaction/process`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-MerchantId": config.SBP_MERCHANT_ID as string,
          "X-Secret": config.SBP_API_SECRET as string,
        },
        signal: AbortSignal.timeout(SBP_PAYMENT_REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          paymentMethod: 2,
          paymentDetails: {
            amount: input.amount_rub,
            currency: "RUB",
          },
          description: input.description,
          return: config.SBP_RETURN_URL,
          failedUrl: config.SBP_FAILED_URL,
          payload: input.token,
          metadata: {
            userId: input.chat_id,
            ...(input.metadata ?? {}),
          },
        }),
      });
    } catch (error) {
      throw new SbpPaymentError(
        "SBP payment request failed",
        "request",
        null,
        "ambiguous",
        error instanceof Error ? error.message : error,
        { cause: error instanceof Error ? error : undefined },
      );
    }

    const rawBody = await response.text();
    let parsedBody: unknown = null;

    if (rawBody.length > 0) {
      try {
        parsedBody = JSON.parse(rawBody) as unknown;
      } catch (error) {
        throw new SbpPaymentError(
          "SBP provider response is not valid JSON",
          "response",
          response.status,
          "ambiguous",
          rawBody,
          { cause: error instanceof Error ? error : undefined },
        );
      }
    }

    if (!response.ok) {
      throw new SbpPaymentError(
        "SBP provider returned a non-success HTTP status",
        "response",
        response.status,
        "ambiguous",
        parsedBody ?? rawBody,
      );
    }

    const payload = isObjectRecord(parsedBody)
      ? parsedBody as SbpApiPayload
      : null;
    const externalPaymentId = normalizeText(payload?.transactionId);
    const checkoutUrl = normalizeText(payload?.redirect);

    if (!externalPaymentId || !checkoutUrl) {
      throw new SbpPaymentError(
        "SBP provider response does not include payment identifiers",
        "response",
        response.status,
        "ambiguous",
        payload ?? rawBody,
      );
    }

    return {
      external_payment_id: externalPaymentId,
      checkout_url: checkoutUrl,
      provider_expires_at: parseExpiresIn(payload?.expiresIn),
    };
  }

  async getTransactionStatus(
    externalPaymentId: string,
  ): Promise<SbpTransactionStatus | null> {
    let response: Response;

    try {
      response = await fetch(`${config.SBP_API_BASE_URL}/transaction/${encodeURIComponent(externalPaymentId)}`, {
        method: "GET",
        headers: {
          "X-MerchantId": config.SBP_MERCHANT_ID as string,
          "X-Secret": config.SBP_API_SECRET as string,
        },
        signal: AbortSignal.timeout(SBP_PAYMENT_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new SbpPaymentError(
        "SBP status request failed",
        "request",
        null,
        "ambiguous",
        error instanceof Error ? error.message : error,
        { cause: error instanceof Error ? error : undefined },
      );
    }

    const rawBody = await response.text();
    let parsedBody: unknown = null;
    if (rawBody.length > 0) {
      try {
        parsedBody = JSON.parse(rawBody) as unknown;
      } catch (error) {
        throw new SbpPaymentError(
          "SBP status response is not valid JSON",
          "response",
          response.status,
          "ambiguous",
          rawBody,
          { cause: error instanceof Error ? error : undefined },
        );
      }
    }

    if (!response.ok) {
      throw new SbpPaymentError(
        "SBP provider returned a non-success status response",
        "response",
        response.status,
        "ambiguous",
        parsedBody ?? rawBody,
      );
    }

    const payload = isObjectRecord(parsedBody)
      ? parsedBody as SbpApiPayload
      : null;

    return normalizeTransactionStatus(payload?.status);
  }
}
