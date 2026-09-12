export type FreeBalances = {
  free_scene_unlocks?: number | null;
  free_photo_unlocks?: number | null;
  free_fast_scene_skips?: number | null;
};

function count(value: number | null | undefined): number {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function plural(
  value: number,
  forms: readonly [string, string, string],
): string {
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

export function formatFreeBalances(balances: FreeBalances): string | null {
  const sceneUnlocks = count(balances.free_scene_unlocks);
  const photos = count(balances.free_photo_unlocks);
  const sceneSkips = count(balances.free_fast_scene_skips);
  const lines: string[] = [];

  if (sceneUnlocks > 0) {
    lines.push(`• ${sceneUnlocks} ${plural(sceneUnlocks, [
      "бесплатная разблокировка сцены",
      "бесплатные разблокировки сцены",
      "бесплатных разблокировок сцены",
    ])}`);
  }
  if (photos > 0) {
    lines.push(`• ${photos} ${plural(photos, [
      "бесплатное фото",
      "бесплатных фото",
      "бесплатных фото",
    ])}`);
  }
  if (sceneSkips > 0) {
    lines.push(`• ${sceneSkips} ${plural(sceneSkips, [
      "бесплатный пропуск сцены",
      "бесплатных пропуска сцены",
      "бесплатных пропусков сцены",
    ])}`);
  }

  return lines.length > 0 ? `🎁 У тебя есть:\n${lines.join("\n")}` : null;
}

export function prependFreeBalances(
  text: string | null,
  balances: FreeBalances,
): string | null {
  const giftBlock = formatFreeBalances(balances);
  if (!giftBlock) return text;
  return text ? `${giftBlock}\n\n${text}` : giftBlock;
}
