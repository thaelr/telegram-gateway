import { getRequestContext } from '../requestContext.js';
import { TelegramStarsInvoiceError } from '../payments/stars.js';

export class MediaCommerceOperationError extends Error {
  constructor(
    message: string,
    readonly operation: string,
    readonly code: string | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MediaCommerceOperationError";
  }
}

export function extractErrorCode(error: unknown): string | null {
  if (
    typeof error === "object"
    && error != null
    && "code" in error
    && typeof error.code === "string"
    && error.code.trim().length > 0
  ) {
    return error.code.trim();
  }

  return null;
}

export function toOperationError(operation: string, error: unknown): MediaCommerceOperationError {
  if (error instanceof MediaCommerceOperationError) {
    return error;
  }

  return new MediaCommerceOperationError(
    "MediaCommerce operation failed",
    operation,
    extractErrorCode(error),
    { cause: error instanceof Error ? error : undefined },
  );
}

export function toSafeTelegramStarsDetails(details: unknown): Record<string, unknown> | null {
  if (typeof details !== "object" || details == null || Array.isArray(details)) {
    return null;
  }

  const source = details as Record<string, unknown>;
  const safeDetails: Record<string, unknown> = {};
  if (typeof source.ok === "boolean") safeDetails.ok = source.ok;
  if (typeof source.error_code === "number" && Number.isInteger(source.error_code)) {
    safeDetails.error_code = source.error_code;
  }
  if (typeof source.description === "string" && source.description.trim().length > 0) {
    safeDetails.description = source.description.trim();
  }

  return Object.keys(safeDetails).length > 0 ? safeDetails : null;
}

export type OperationLogContext = {
  chat_id?: number | null;
  payment_kind?: string | null;
  sku?: string | null;
  invoice_status?: string | null;
  input_is_array?: boolean;
  input_length?: number | null;
};

export async function runOperation<T>(operation: string,
    context: OperationLogContext,
    execute: () => Promise<T>,
  ): Promise<T> {
    const requestId = getRequestContext()?.requestId ?? null;
    const startedAt = Date.now();

    try {
      return await execute();
    } catch (error) {
      const operationError = toOperationError(operation, error);
      const starsError = error instanceof TelegramStarsInvoiceError ? error : null;
      console.error(`[media_commerce] ${operation}`, {
        request_id: requestId,
        operation,
        status: "error",
        duration_ms: Date.now() - startedAt,
        ...context,
        code: operationError.code,
        message: error instanceof Error ? error.message : "Unknown error",
        ...(starsError
          ? {
              stage: starsError.stage,
              statusCode: starsError.statusCode,
              description: starsError.description,
              details: toSafeTelegramStarsDetails(starsError.details),
            }
          : {}),
      });
      throw operationError;
    }
  }

export async function runRepositoryOperation<T>(operation: string,
    context: OperationLogContext,
    execute: () => Promise<T>,
  ): Promise<T> {
    return runOperation(operation, context, execute);
  }
