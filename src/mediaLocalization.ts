import { AsyncLocalStorage } from "node:async_hooks";
import { config, type TelegramUxCopy } from "./config.js";

type MediaLocalizationContext = {
  language: "ru" | "en";
  uxCopy: TelegramUxCopy;
};

const storage = new AsyncLocalStorage<MediaLocalizationContext>();

export function runWithMediaLocalization<T>(
  context: MediaLocalizationContext,
  callback: () => T,
): T {
  return storage.run(context, callback);
}

export function getMediaLanguage(): "ru" | "en" {
  return storage.getStore()?.language ?? "ru";
}

export function getMediaUxCopy(): TelegramUxCopy {
  return storage.getStore()?.uxCopy ?? config.TELEGRAM_UX_COPY_JSON;
}
