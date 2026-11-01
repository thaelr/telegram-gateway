import { normalizeNonNegativeInteger } from "./numeric.js";
import type { TelegramUxCopy } from "./telegramUxCopy.js";

export type FreeBalances = {
  free_scene_unlocks?: number | null;
  free_photo_unlocks?: number | null;
  free_fast_scene_skips?: number | null;
};

function count(value: number | null | undefined): number {
  return normalizeNonNegativeInteger(value) ?? 0;
}

function plural(
  value: number,
  forms: { one: string; few: string; many: string },
): string {
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 14) return forms.many;
  if (mod10 === 1) return forms.one;
  if (mod10 >= 2 && mod10 <= 4) return forms.few;
  return forms.many;
}

type FreeBalanceCopy = NonNullable<TelegramUxCopy["free_balances"]>;

export function formatFreeBalances(
  balances: FreeBalances,
  copy?: FreeBalanceCopy,
): string | null {
  if (!copy) return null;
  const sceneUnlocks = count(balances.free_scene_unlocks);
  const photos = count(balances.free_photo_unlocks);
  const sceneSkips = count(balances.free_fast_scene_skips);
  const lines: string[] = [];

  if (sceneUnlocks > 0) {
    lines.push(`• ${plural(sceneUnlocks, copy.scene_unlock).replaceAll("{count}", String(sceneUnlocks))}`);
  }
  if (photos > 0) {
    lines.push(`• ${plural(photos, copy.photo).replaceAll("{count}", String(photos))}`);
  }
  if (sceneSkips > 0) {
    lines.push(`• ${plural(sceneSkips, copy.fast_scene_skip).replaceAll("{count}", String(sceneSkips))}`);
  }

  return lines.length > 0 ? `${copy.heading}\n${lines.join("\n")}` : null;
}

export function prependFreeBalances(
  text: string | null,
  balances: FreeBalances,
  copy?: FreeBalanceCopy,
): string | null {
  const giftBlock = formatFreeBalances(balances, copy);
  if (!giftBlock) return text;
  return text ? `${giftBlock}\n\n${text}` : giftBlock;
}
