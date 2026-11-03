import { sql } from "./db.js";
import { normalizeNonNegativeInteger, normalizePositiveInteger } from "./numeric.js";

export type TelegramNavigationScreen = "character_gallery" | "character_mode";

export type NavigationRegistration = {
  accepted: boolean;
  reason: "accepted" | "duplicate" | "stale_update" | "stale_menu";
  navigation_revision: number;
  active_menu_screen: string | null;
  active_menu_message_id: number | null;
  active_menu_media_message_ids: number[];
};

export type NavigationRenderClaim = {
  active_menu_screen: string | null;
  active_menu_message_id: number | null;
  active_menu_media_message_ids: number[];
};

type NavigationStateRow = {
  accepted?: boolean;
  reason?: NavigationRegistration["reason"];
  navigation_revision?: number | string;
  active_menu_screen: string | null;
  active_menu_message_id: number | string | null;
  active_menu_media_message_ids_json: unknown;
};

function normalizeMessageIds(value: unknown): number[] {
  const input = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? (() => {
        try {
          const parsed = JSON.parse(value) as unknown;
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })()
      : [];

  return input
    .map(normalizePositiveInteger)
    .filter((item): item is number => item != null);
}

function normalizeState(row: NavigationStateRow): NavigationRenderClaim {
  return {
    active_menu_screen: row.active_menu_screen,
    active_menu_message_id: normalizePositiveInteger(row.active_menu_message_id),
    active_menu_media_message_ids: normalizeMessageIds(
      row.active_menu_media_message_ids_json,
    ),
  };
}

export class TelegramNavigationRepository {
  constructor(private readonly query: typeof sql = sql) {}

  async register(input: {
    chatId: number;
    updateId: number;
    source: string;
    sourceUserId: number | null;
    expectedMenuScreen: TelegramNavigationScreen | null;
    inboundMessageId: number | null;
  }): Promise<NavigationRegistration> {
    const rows = await this.query<NavigationStateRow[]>`
      SELECT *
      FROM app_private.register_telegram_navigation(
        ${input.chatId}::bigint,
        ${input.updateId}::bigint,
        ${input.source}::text,
        ${input.sourceUserId}::bigint,
        ${input.expectedMenuScreen}::text,
        ${input.inboundMessageId}::bigint
      )
    `;
    const row = rows[0];
    if (!row?.reason) {
      throw new Error("Telegram navigation registration returned no result");
    }
    const revision = normalizeNonNegativeInteger(row.navigation_revision);
    if (revision == null) {
      throw new Error("Telegram navigation registration returned an invalid revision");
    }

    return {
      accepted: row.accepted === true,
      reason: row.reason,
      navigation_revision: revision,
      ...normalizeState(row),
    };
  }

  async observeTelegramUpdate(): Promise<number> {
    const rows = await this.query<Array<{ update_epoch: number | string }>>`
      SELECT app_private.observe_telegram_update() AS update_epoch
    `;
    const epoch = normalizeNonNegativeInteger(rows[0]?.update_epoch);
    if (epoch == null) {
      throw new Error("Telegram update observation returned an invalid epoch");
    }
    return epoch;
  }

  async beginRender(
    chatId: number,
    navigationRevision: number,
  ): Promise<NavigationRenderClaim | null> {
    const rows = await this.query<NavigationStateRow[]>`
      SELECT *
      FROM app_private.begin_telegram_navigation_render(
        ${chatId}::bigint,
        ${navigationRevision}::bigint
      )
    `;
    return rows[0] ? normalizeState(rows[0]) : null;
  }

  async commitRender(input: {
    chatId: number;
    navigationRevision: number;
    screen: TelegramNavigationScreen;
    menuMessageId: number;
    mediaMessageIds: number[];
    selectedCharacterId: number | null;
  }): Promise<boolean> {
    const rows = await this.query<Array<{ committed: boolean }>>`
      SELECT app_private.commit_telegram_navigation_render(
        ${input.chatId}::bigint,
        ${input.navigationRevision}::bigint,
        ${input.screen}::text,
        ${input.menuMessageId}::bigint,
        ${JSON.stringify(input.mediaMessageIds)}::text::jsonb,
        ${input.selectedCharacterId}::smallint
      ) AS committed
    `;
    return rows[0]?.committed === true;
  }
}
