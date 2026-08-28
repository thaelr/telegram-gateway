import type {
  InteractionTokenRow,
  InvoiceTokenPayload,
  MediaButton,
  MediaContext,
  MediaReplyMarkup,
  MediaUnlockedItem,
} from "../mediaCommerceTypes.js";
import {
  buildRandomToken,
  INVOICE_TTL_MS,
  normalizeLowerString,
  normalizePositiveInteger,
  normalizeString,
  parseJsonArray,
  parseJsonObject,
} from "./utils.js";
import { resolvePhotoPlanByAmount } from "./plans.js";

export const PHOTO_ACTIONS = new Set([
  "photo_request",
  "photo_regen",
  "photo_prev",
  "photo_next",
]);

export type MediaActionDecision = {
  operation: "noop" | "edit_photo" | "edit_photo_with_invoice_link";
  photo_url: string | null;
  selected_uuid: string | null;
  current_uuid: string | null;
  reply_markup: MediaReplyMarkup | null;
  token_rows: InteractionTokenRow[];
  log_event_type: string | null;
  access_mode: string | null;
  log_price_xtr: number;
  price_required: number;
  invoice_kind: "photo" | null;
  invoice_sku: string | null;
  invoice_amount: number | null;
  original_invoice_amount: number | null;
  promo_key: string | null;
  invoice_title: string | null;
  invoice_description: string | null;
  invoice_label: string | null;
  invoice_payload_json: InvoiceTokenPayload | null;
  invoice_button_text: string | null;
  fulfillment_invoice_token: string | null;
  caption_text: string | null;
  caption_entities_json: unknown[] | null;
};

export function calculateMediaPriceRequired(input: {
  subscription_active: boolean;
  delivered_in_scene: number;
  base_price_xtr: number;
}): number {
  return input.subscription_active
    ? 0
    : input.delivered_in_scene < 3
      ? 0
      : input.base_price_xtr;
}

export function normalizeUnlockedItems(value: unknown): MediaUnlockedItem[] {
  const raw = parseJsonArray(value) ?? [];
  const unique: MediaUnlockedItem[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const objectItem = parseJsonObject(item);
    const uuid = normalizeLowerString(
      typeof objectItem?.uuid === "string" ? objectItem.uuid : null,
    );
    const photoUrl = normalizeString(
      typeof objectItem?.photo_url === "string" ? objectItem.photo_url : null,
    );
    if (!uuid || !photoUrl || seen.has(uuid)) {
      continue;
    }
    seen.add(uuid);
    unique.push({
      uuid,
      photo_url: photoUrl,
      sort_order: Number(objectItem?.sort_order ?? 0),
      first_unlocked_at:
        typeof objectItem?.first_unlocked_at === "string"
          ? objectItem.first_unlocked_at
          : null,
    });
  }

  return unique;
}

export function normalizeNextUnseen(
  value: unknown,
): { uuid: string; photo_url: string; sort_order: number } | null {
  const objectValue = parseJsonObject(value);
  const uuid = normalizeLowerString(
    typeof objectValue?.uuid === "string" ? objectValue.uuid : null,
  );
  const photoUrl = normalizeString(
    typeof objectValue?.photo_url === "string" ? objectValue.photo_url : null,
  );
  if (!uuid || !photoUrl) return null;
  return {
    uuid,
    photo_url: photoUrl,
    sort_order: Number(objectValue?.sort_order ?? 0),
  };
}

export function buildCallbackTokenRow(input: {
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  scene_turn_no: number | null;
  media_signature: string | null;
  target_message_id: number | null;
  current_uuid: string | null;
  base_price_xtr: number;
  next_action: string;
  requested_action: string;
  extraPayload?: Record<string, unknown>;
}): InteractionTokenRow {
  const token = buildRandomToken("btn");

  return {
    token,
    kind: "button_callback",
    chat_id: input.chat_id,
    scene_session_id: input.scene_session_id,
    turn_no: input.turn_no,
    payload_json: {
      action_kind: input.next_action,
      chat_id: input.chat_id,
      scene_session_id: input.scene_session_id,
      turn_no: input.turn_no,
      scene_turn_no: input.scene_turn_no,
      media_signature: input.media_signature,
      target_message_id: input.target_message_id,
      current_uuid: input.current_uuid,
      base_price_xtr: input.base_price_xtr,
      requested_action:
        input.next_action === "photo_regen"
          ? "photo_regen"
          : input.requested_action,
      ...(input.extraPayload ?? {}),
    },
    status: "active",
    action_kind: input.next_action,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

export function buildPhotoInvoiceInput(input: {
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  scene_turn_no: number | null;
  media_signature: string | null;
  target_message_id: number | null;
  current_uuid: string | null;
  base_price_xtr: number;
  amount_xtr: number;
  original_amount_xtr?: number | null;
  promo_key?: string | null;
  invoice_sku: string;
  invoice_title: string;
  invoice_description: string;
  invoice_label: string;
  invoice_button_text: string;
  payload_json: InvoiceTokenPayload;
}) {
  const token = buildRandomToken("inv");

  return {
    token,
    kind: "invoice_payload",
    chat_id: input.chat_id,
    scene_session_id: input.scene_session_id,
    turn_no: input.turn_no,
    scene_turn_no: input.scene_turn_no,
    payload_json: {
      ...input.payload_json,
      original_amount_xtr: input.original_amount_xtr ?? input.amount_xtr,
      promo_key: input.promo_key ?? null,
    },
    action_kind: "photo_payment",
    sku: input.invoice_sku,
    amount_xtr: input.amount_xtr,
    telegram_invoice_payload: token,
    expires_at: new Date(Date.now() + INVOICE_TTL_MS).toISOString(),
    invoice_title: input.invoice_title,
    invoice_description: input.invoice_description,
    invoice_label: input.invoice_label,
    invoice_button_text: input.invoice_button_text,
  };
}

export function buildMediaAction(context: MediaContext): MediaActionDecision {
  const unlockedItems = normalizeUnlockedItems(context.unlocked_items_json);
  const nextUnseen = normalizeNextUnseen(context.next_unseen_json);
  const actionKind = normalizeString(context.action_kind) ?? "";
  const callbackValid = context.callback_valid !== false;
  const subscriptionActive = context.subscription_active === true;
  const deliveredInScene = Number(context.delivered_in_scene ?? 0);
  const basePrice = Number(context.base_price_xtr ?? 10);
  const forceDeliver = context.force_deliver_after_payment === true;
  const priceRequired = calculateMediaPriceRequired({
    subscription_active: subscriptionActive,
    delivered_in_scene: deliveredInScene,
    base_price_xtr: basePrice,
  });
  const targetMessageId = normalizePositiveInteger(context.target_message_id);
  const currentUuid = normalizeLowerString(context.current_uuid);
  let captionText = normalizeString(context.panel_text);
  let captionEntities = parseJsonArray(context.panel_entities_json) ?? [];

  if (captionText && captionText.length > 1024) {
    captionText = `${captionText.slice(0, 1021)}...`;
    captionEntities = [];
  }
  if (!captionText) {
    captionEntities = [];
  }

  const base: MediaActionDecision = {
    operation: "noop",
    photo_url: null,
    selected_uuid: null,
    current_uuid: currentUuid,
    reply_markup: null,
    token_rows: [],
    log_event_type: null,
    access_mode: null,
    log_price_xtr: 0,
    price_required: priceRequired,
    invoice_kind: null,
    invoice_sku: null,
    invoice_amount: null,
    original_invoice_amount: null,
    promo_key: null,
    invoice_title: null,
    invoice_description: null,
    invoice_label: null,
    invoice_payload_json: null,
    invoice_button_text: null,
    fulfillment_invoice_token: null,
    caption_text: captionText,
    caption_entities_json: captionEntities,
  };

  if (!callbackValid || !targetMessageId) {
    return base;
  }

  let selected: MediaUnlockedItem | null = null;
  let operation: MediaActionDecision["operation"] = "noop";
  let logEventType: string | null = null;
  let accessMode: string | null = null;
  let deliverUnlock = false;

  if (actionKind === "photo_prev" || actionKind === "photo_next") {
    if (unlockedItems.length > 0) {
      let index = unlockedItems.findIndex((item) => item.uuid === currentUuid);
      if (index < 0) index = 0;
      if (actionKind === "photo_prev") {
        index = index <= 0 ? unlockedItems.length - 1 : index - 1;
      }
      if (actionKind === "photo_next") {
        index = index >= unlockedItems.length - 1 ? 0 : index + 1;
      }
      selected = unlockedItems[index] ?? null;
      if (selected) {
        operation = "edit_photo";
        logEventType = "media.photo.viewed.nav";
        accessMode = "nav";
      }
    }
  } else if (actionKind === "photo_request" || actionKind === "photo_regen") {
    if (nextUnseen) {
      if (!forceDeliver && priceRequired > 0) {
        const currentUnlocked =
          unlockedItems.find((item) => item.uuid === currentUuid)
          ?? unlockedItems[unlockedItems.length - 1]
          ?? null;
        if (currentUnlocked) {
          selected = currentUnlocked;
          operation = "edit_photo";
          logEventType = "media.photo.panel.payment_ready";
          accessMode = "paid";
        }
      } else {
        selected = {
          uuid: nextUnseen.uuid,
          photo_url: nextUnseen.photo_url,
          sort_order: nextUnseen.sort_order,
        };
        operation = "edit_photo";
        deliverUnlock = true;
        accessMode =
          normalizeString(context.paid_access_mode)
          ?? (subscriptionActive
            ? "subscription"
            : deliveredInScene < 3
              ? "free"
              : "paid");
        logEventType =
          accessMode === "subscription"
            ? "media.photo.unlocked.subscription"
            : accessMode === "paid"
              ? "media.photo.unlocked.paid"
              : "media.photo.unlocked.free";
      }
    }
  }

  if (operation !== "edit_photo" || !selected) {
    return base;
  }

  const unlockedAfter = unlockedItems.slice();
  if (deliverUnlock && !unlockedAfter.some((item) => item.uuid === selected?.uuid)) {
    unlockedAfter.push({
      uuid: selected.uuid,
      photo_url: selected.photo_url,
      sort_order: selected.sort_order,
      first_unlocked_at: new Date().toISOString(),
    });
  }

  const deliveredAfter = deliveredInScene + (deliverUnlock ? 1 : 0);
  const unseenAfter = Math.max(
    0,
    Number(context.unseen_available ?? 0) - (deliverUnlock ? 1 : 0),
  );
  const nextPrice = calculateMediaPriceRequired({
    subscription_active: subscriptionActive,
    delivered_in_scene: deliveredAfter,
    base_price_xtr: basePrice,
  });
  const tokenRows: InteractionTokenRow[] = [];
  const keyboard: MediaButton[][] = [];

  const addCallbackRow = (
    buttons: Array<{ text: string; action: string; extraPayload?: Record<string, unknown> }>,
  ) => {
    const rowButtons: MediaButton[] = [];
    for (const button of buttons) {
      const tokenRow = buildCallbackTokenRow({
        chat_id: context.chat_id,
        scene_session_id: context.scene_session_id,
        turn_no: context.turn_no,
        scene_turn_no: context.scene_turn_no,
        media_signature: context.media_signature,
        target_message_id: targetMessageId,
        current_uuid: selected.uuid,
        base_price_xtr: basePrice,
        next_action: button.action,
        requested_action:
          normalizeString(context.requested_action) ?? "photo_request",
        extraPayload: button.extraPayload,
      });
      tokenRows.push(tokenRow);
      rowButtons.push({
        text: button.text,
        callback_data: tokenRow.token,
      });
    }
    if (rowButtons.length > 0) {
      keyboard.push(rowButtons);
    }
  };

  if (unlockedAfter.length > 1) {
    addCallbackRow([
      { text: "◀", action: "photo_prev" },
      { text: "▶", action: "photo_next" },
    ]);
  }

  let finalOperation: MediaActionDecision["operation"] = "edit_photo";
  let invoiceKind: "photo" | null = null;
  let invoiceSku: string | null = null;
  let invoiceAmount: number | null = null;
  let originalInvoiceAmount: number | null = null;
  let promoKey: string | null = null;
  let invoiceTitle: string | null = null;
  let invoiceDescription: string | null = null;
  let invoiceLabel: string | null = null;
  let invoicePayload: InvoiceTokenPayload | null = null;
  let invoiceButtonText: string | null = null;

  if (unseenAfter > 0) {
    if (nextPrice > 0) {
      const photoPlan = resolvePhotoPlanByAmount(nextPrice);
      finalOperation = "edit_photo_with_invoice_link";
      invoiceKind = "photo";
      invoiceSku = photoPlan.sku;
      invoiceAmount = photoPlan.amount_xtr;
      originalInvoiceAmount = photoPlan.original_amount_xtr;
      promoKey = photoPlan.promo_key;
      invoiceTitle = photoPlan.title;
      invoiceDescription = photoPlan.description;
      invoiceLabel = photoPlan.label;
      invoiceButtonText = photoPlan.button_text;
      invoicePayload = {
        action_kind: "photo_payment",
        chat_id: context.chat_id,
        scene_session_id: context.scene_session_id,
        turn_no: context.turn_no,
        scene_turn_no: context.scene_turn_no,
        media_signature: context.media_signature,
        target_message_id: targetMessageId,
        current_uuid: selected.uuid,
        base_price_xtr: basePrice,
        requested_action: "photo_regen",
        panel_text: captionText,
        panel_entities_json: captionEntities,
        original_amount_xtr: photoPlan.original_amount_xtr,
        promo_key: photoPlan.promo_key,
      };
    } else {
      addCallbackRow([{ text: "Ещё фото", action: "photo_regen" }]);
    }
  }

  return {
    operation: finalOperation,
    photo_url: selected.photo_url,
    selected_uuid: selected.uuid,
    current_uuid: selected.uuid,
    reply_markup: { inline_keyboard: keyboard },
    token_rows: tokenRows,
    log_event_type: logEventType,
    access_mode: accessMode,
    log_price_xtr: accessMode === "paid" && deliverUnlock ? basePrice : 0,
    price_required: nextPrice,
    invoice_kind: invoiceKind,
    invoice_sku: invoiceSku,
    invoice_amount: invoiceAmount,
    original_invoice_amount: originalInvoiceAmount,
    promo_key: promoKey,
    invoice_title: invoiceTitle,
    invoice_description: invoiceDescription,
    invoice_label: invoiceLabel,
    invoice_payload_json: invoicePayload,
    invoice_button_text: invoiceButtonText,
    fulfillment_invoice_token: deliverUnlock
      ? normalizeString(context.invoice_token)
      : null,
    caption_text: captionText,
    caption_entities_json: captionEntities,
  };
}
