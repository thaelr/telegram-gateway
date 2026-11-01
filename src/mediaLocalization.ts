import { AsyncLocalStorage } from "node:async_hooks";
import { config, type TelegramUxCopy } from "./config.js";

type MediaLocalizationContext = {
  language: string;
  uxCopy: TelegramUxCopy;
  paymentMethods?: Array<"stars" | "sbp">;
  commerceCopy?: Record<string, unknown>;
};

const storage = new AsyncLocalStorage<MediaLocalizationContext>();

export function runWithMediaLocalization<T>(
  context: MediaLocalizationContext,
  callback: () => T,
): T {
  return storage.run(context, callback);
}

export function getMediaLanguage(): string {
  return storage.getStore()?.language ?? "ru";
}

export function getMediaUxCopy(): TelegramUxCopy {
  const copy = storage.getStore()?.uxCopy;
  if (!copy) {
    throw new Error("Telegram localization is unavailable: required RU copy was not loaded");
  }
  return copy;
}

export function getMediaPaymentMethods(): Array<"stars" | "sbp"> {
  return [...(storage.getStore()?.paymentMethods
    ?? (config.SBP_ENABLED ? ["sbp", "stars"] : ["stars"]))];
}

export function getMediaCommerceCopy(): Record<string, unknown> {
  return storage.getStore()?.commerceCopy ?? {};
}
