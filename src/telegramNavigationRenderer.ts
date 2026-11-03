import type {
  TelegramNavigationRepository,
  TelegramNavigationScreen,
} from "./telegramNavigationRepository.js";
import {
  TelegramUxRequestError,
  type TelegramNavigationTransport,
} from "./telegramBotClient.js";

export type TelegramNavigationRenderInput = {
  telegram_chat_id: number;
  navigation_revision: number;
  screen: TelegramNavigationScreen;
  text: string;
  reply_markup: Record<string, unknown>;
  parse_mode?: "HTML";
  disable_web_page_preview?: boolean;
  gallery_media?: Array<{ type: "photo"; media: string }>;
  menu_photo_url?: string | null;
  selected_character_i?: number | null;
};

export type TelegramNavigationRenderResult = {
  status: "committed" | "stale_or_duplicate" | "failed" | "uncertain";
  screen: TelegramNavigationScreen;
  navigation_revision: number;
  menu_message_id: number | null;
  media_message_ids: number[];
  reason?: string;
};

function uniqueMessageIds(values: Array<number | null | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => value != null && value > 0))];
}

export class TelegramNavigationRenderer {
  constructor(
    private readonly repository: Pick<
      TelegramNavigationRepository,
      "beginRender" | "commitRender"
    >,
    private readonly telegram: TelegramNavigationTransport,
  ) {}

  private async cleanup(chatId: number, messageIds: number[]): Promise<void> {
    for (const messageId of uniqueMessageIds(messageIds)) {
      try {
        await this.telegram.deleteMessage(chatId, messageId);
      } catch {
        // Cleanup is best effort and must never cause a duplicate screen retry.
      }
    }
  }

  async render(
    input: TelegramNavigationRenderInput,
  ): Promise<TelegramNavigationRenderResult> {
    const claim = await this.repository.beginRender(
      input.telegram_chat_id,
      input.navigation_revision,
    );
    if (!claim) {
      return {
        status: "stale_or_duplicate",
        screen: input.screen,
        navigation_revision: input.navigation_revision,
        menu_message_id: null,
        media_message_ids: [],
        reason: "navigation_revision_not_current_or_already_started",
      };
    }

    const sentMessageIds: number[] = [];
    let menuMessageId: number | null = null;
    let mediaMessageIds: number[] = [];

    try {
      if (input.screen === "character_gallery") {
        const media = input.gallery_media ?? [];
        if (media.length === 1) {
          try {
            const messageId = await this.telegram.sendPhoto({
              chat_id: input.telegram_chat_id,
              photo: media[0]!.media,
            });
            mediaMessageIds = [messageId];
            sentMessageIds.push(messageId);
          } catch (error) {
            if (error instanceof TelegramUxRequestError && error.outcome === "uncertain") {
              return {
                status: "uncertain",
                screen: input.screen,
                navigation_revision: input.navigation_revision,
                menu_message_id: null,
                media_message_ids: [],
                reason: error.message,
              };
            }
            // Confirmed media failure keeps the existing text-only fallback.
          }
        } else if (media.length > 1) {
          try {
            mediaMessageIds = await this.telegram.sendMediaGroup({
              chat_id: input.telegram_chat_id,
              media,
            });
            sentMessageIds.push(...mediaMessageIds);
          } catch (error) {
            if (error instanceof TelegramUxRequestError && error.outcome === "uncertain") {
              return {
                status: "uncertain",
                screen: input.screen,
                navigation_revision: input.navigation_revision,
                menu_message_id: null,
                media_message_ids: [],
                reason: error.message,
              };
            }
            // Confirmed media failure keeps the existing text-only fallback.
          }
        }

        menuMessageId = await this.telegram.sendMessage({
          chat_id: input.telegram_chat_id,
          text: input.text,
          parse_mode: input.parse_mode ?? "HTML",
          disable_web_page_preview: input.disable_web_page_preview ?? true,
          reply_markup: input.reply_markup,
        });
        sentMessageIds.push(menuMessageId);
      } else if (input.menu_photo_url) {
        try {
          menuMessageId = await this.telegram.sendPhoto({
            chat_id: input.telegram_chat_id,
            photo: input.menu_photo_url,
            caption: input.text,
            parse_mode: input.parse_mode ?? "HTML",
            reply_markup: input.reply_markup,
          });
          sentMessageIds.push(menuMessageId);
        } catch (error) {
          if (error instanceof TelegramUxRequestError && error.outcome === "uncertain") {
            return {
              status: "uncertain",
              screen: input.screen,
              navigation_revision: input.navigation_revision,
              menu_message_id: null,
              media_message_ids: [],
              reason: error.message,
            };
          }
          menuMessageId = await this.telegram.sendMessage({
            chat_id: input.telegram_chat_id,
            text: input.text,
            parse_mode: input.parse_mode ?? "HTML",
            disable_web_page_preview: input.disable_web_page_preview ?? true,
            reply_markup: input.reply_markup,
          });
          sentMessageIds.push(menuMessageId);
        }
      } else {
        menuMessageId = await this.telegram.sendMessage({
          chat_id: input.telegram_chat_id,
          text: input.text,
          parse_mode: input.parse_mode ?? "HTML",
          disable_web_page_preview: input.disable_web_page_preview ?? true,
          reply_markup: input.reply_markup,
        });
        sentMessageIds.push(menuMessageId);
      }
    } catch (error) {
      if (error instanceof TelegramUxRequestError && error.outcome === "uncertain") {
        return {
          status: "uncertain",
          screen: input.screen,
          navigation_revision: input.navigation_revision,
          menu_message_id: menuMessageId,
          media_message_ids: mediaMessageIds,
          reason: error.message,
        };
      }
      await this.cleanup(input.telegram_chat_id, sentMessageIds);
      return {
        status: "failed",
        screen: input.screen,
        navigation_revision: input.navigation_revision,
        menu_message_id: null,
        media_message_ids: [],
        reason: error instanceof Error ? error.message : "telegram_send_failed",
      };
    }

    if (menuMessageId == null) {
      await this.cleanup(input.telegram_chat_id, sentMessageIds);
      return {
        status: "failed",
        screen: input.screen,
        navigation_revision: input.navigation_revision,
        menu_message_id: null,
        media_message_ids: [],
        reason: "mandatory_menu_message_missing",
      };
    }

    const committed = await this.repository.commitRender({
      chatId: input.telegram_chat_id,
      navigationRevision: input.navigation_revision,
      screen: input.screen,
      menuMessageId,
      mediaMessageIds,
      selectedCharacterId: input.screen === "character_mode"
        ? input.selected_character_i ?? null
        : null,
    });

    if (!committed) {
      await this.cleanup(input.telegram_chat_id, sentMessageIds);
      return {
        status: "stale_or_duplicate",
        screen: input.screen,
        navigation_revision: input.navigation_revision,
        menu_message_id: null,
        media_message_ids: [],
        reason: "navigation_revision_lost_before_commit",
      };
    }

    const oldMessageIds = uniqueMessageIds([
      claim.active_menu_message_id,
      ...claim.active_menu_media_message_ids,
    ]).filter((messageId) => !sentMessageIds.includes(messageId));
    await this.cleanup(input.telegram_chat_id, oldMessageIds);

    return {
      status: "committed",
      screen: input.screen,
      navigation_revision: input.navigation_revision,
      menu_message_id: menuMessageId,
      media_message_ids: mediaMessageIds,
    };
  }
}
