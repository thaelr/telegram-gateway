import { config } from "../config.js";

export type CreateSbpPaymentInput = {
  token: string;
  chat_id: number;
  sku: string;
  title: string;
  description: string;
  amount_rub: number;
  metadata?: Record<string, unknown>;
};

export type CreateSbpPaymentResult = {
  external_payment_id: string;
  checkout_url: string;
};

export interface SbpPaymentClient {
  createPayment(
    input: CreateSbpPaymentInput,
  ): Promise<CreateSbpPaymentResult>;
}

type SbpApiPayload = {
  transactionId?: unknown;
  redirect?: unknown;
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

export class SbpPaymentError extends Error {
  readonly code = "sbp_payment_creation_failed";

  constructor(
    message: string,
    readonly stage: "request" | "response",
    readonly statusCode: number | null,
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
        payload ?? rawBody,
      );
    }

    return {
      external_payment_id: externalPaymentId,
      checkout_url: checkoutUrl,
    };
  }
}
