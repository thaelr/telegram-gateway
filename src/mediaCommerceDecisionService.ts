import { config } from "./config.js";
import {
  buildCallbackTokenRow,
  buildMediaAction,
  buildPhotoInvoiceInput,
  calculateMediaPriceRequired,
  PHOTO_ACTIONS,
} from "./mediaCommerce/mediaAction.js";
import {
  INVOICE_PAYLOAD_KIND,
  hasExpectedPaymentDetails,
  resolveInvoiceActionResult,
  toPaidInvoiceToken,
} from "./mediaCommerce/paymentFlow.js";
import {
  appendInvoiceButton,
  buildBaseResponse,
} from "./mediaCommerce/responseBuilders.js";
import {
  buildSubscriptionInvoiceInput,
  buildSubscriptionOfferMessage,
  mergeStoredRowsWithMetadata,
} from "./mediaCommerce/subscriptionFlow.js";
import {
  extractPanelFromRawUpdate,
  isExpired,
  normalizeBoolean,
  normalizeLowerString,
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
  normalizeString,
  parseJsonArray,
  parseJsonObject,
} from "./mediaCommerce/utils.js";
import { MediaCommerceRepository } from "./mediaCommerceRepository.js";
import type {
  MediaCommerceDecisionRequest,
  MediaCommerceDecisionResponse,
  MediaCommerceRoute,
  MediaContext,
  MediaOfferStats,
  PaidInvoiceToken,
  StoredInvoiceToken,
} from "./mediaCommerceTypes.js";

type MediaRepository = Pick<
  MediaCommerceRepository,
  | "loadOfferStats"
  | "upsertCallbackTokens"
  | "upsertInvoiceToken"
  | "loadCallbackToken"
  | "loadMediaContext"
  | "storePanel"
  | "loadInvoiceToken"
  | "storePrecheckoutResult"
  | "markInvoicePaid"
  | "activateSubscription"
  | "storePhotoEvent"
  | "storeInvoiceLinks"
  | "loadStoredInvoiceTokens"
  | "storeSubscriptionOfferMessageId"
>;

function classifyRoute(input: MediaCommerceDecisionRequest): MediaCommerceRoute {
  const mode = normalizeString(input.interaction_mode);
  const eventType = normalizeString(input.event_type);

  if (mode === "prepare_offer") return "prepare_offer";
  if (mode === "finalize_offer") return "finalize_offer";
  if (mode === "feature_offer") return "feature_offer";
  if (mode === "subscription_offer") return "subscription_offer";
  if (mode === "finalize_photo_event") return "finalize_photo_event";
  if (mode === "finalize_subscription_offer") return "finalize_subscription_offer";
  if (eventType === "callback_query.received") return "callback";
  if (eventType === "payment.pre_checkout.received") return "pre_checkout";
  if (eventType === "payment.success.received") return "payment_success";
  return "noop";
}

export class MediaCommerceDecisionService {
  constructor(private readonly repository: MediaRepository) {}

  async evaluate(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const route = classifyRoute(input);

    switch (route) {
      case "prepare_offer":
        return this.evaluatePrepareOffer(input);
      case "finalize_offer":
        return this.evaluateFinalizeOffer(input);
      case "feature_offer":
        return this.evaluateFeatureOffer(input);
      case "callback":
        return this.evaluateCallback(input);
      case "pre_checkout":
        return this.evaluatePrecheckout(input);
      case "payment_success":
        return this.evaluatePaymentSuccess(input);
      case "subscription_offer":
        return this.evaluateSubscriptionOffer(input);
      case "finalize_photo_event":
        return this.evaluateFinalizePhotoEvent(input);
      case "finalize_subscription_offer":
        return this.evaluateFinalizeSubscriptionOffer(input);
      case "noop":
        return buildBaseResponse(input, route);
    }
  }

  private async evaluatePrepareOffer(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "prepare_offer");
    const chatId = normalizePositiveInteger(input.chat_id);
    if (!chatId) {
      return { ...base, reason: "chat_id_required" };
    }

    const stats = await this.repository.loadOfferStats({
      chat_id: chatId,
      scene_session_id: normalizeString(input.scene_session_id),
      turn_no: normalizeNonNegativeInteger(input.turn_no),
      media_signature: normalizeString(input.media_signature),
      scene_turn_no: normalizeNonNegativeInteger(input.scene_turn_no),
      base_price_xtr: normalizePositiveInteger(input.base_price_xtr) ?? 10,
      should_offer: normalizeBoolean(input.should_offer),
    });

    if (!stats) {
      return { ...base, reason: "offer_stats_not_found" };
    }

    return this.buildPrepareOfferResponse(base, stats);
  }

  private async buildPrepareOfferResponse(
    base: MediaCommerceDecisionResponse,
    stats: MediaOfferStats,
  ): Promise<MediaCommerceDecisionResponse> {
    const deliveredInScene = Number(stats.delivered_in_scene ?? 0);
    const subscriptionActive = stats.subscription_active === true;
    const totalAvailable = Number(stats.total_available ?? 0);
    const unseenAvailable = Number(stats.unseen_available ?? 0);
    const existingPanel = normalizePositiveInteger(stats.existing_panel_message_id);
    const basePrice = Number(stats.base_price_xtr ?? 10);
    const priceRequired = calculateMediaPriceRequired({
      subscription_active: subscriptionActive,
      delivered_in_scene: deliveredInScene,
      base_price_xtr: basePrice,
    });
    const mediaSignature = normalizeString(stats.media_signature);

    if (
      !stats.should_offer
      || !mediaSignature
      || totalAvailable < 1
      || unseenAvailable < 1
      || existingPanel
    ) {
      return {
        ...base,
        chat_id: stats.chat_id,
        scene_session_id: stats.scene_session_id,
        turn_no: stats.turn_no,
        scene_turn_no: stats.scene_turn_no,
        media_signature: mediaSignature,
        base_price_xtr: basePrice,
        price_required: priceRequired,
        operation: "prepare_offer_none",
        has_media_offer: false,
      };
    }

    if (priceRequired > 0) {
      const storedInvoice = await this.repository.upsertInvoiceToken(
        buildPhotoInvoiceInput({
          chat_id: stats.chat_id,
          scene_session_id: stats.scene_session_id,
          turn_no: stats.turn_no,
          scene_turn_no: stats.scene_turn_no,
          media_signature: mediaSignature,
          target_message_id: null,
          current_uuid: null,
          base_price_xtr: basePrice,
          amount_xtr: priceRequired,
          invoice_title: "Фото",
          invoice_description: "Открыть фото для этого момента",
          invoice_label: "Фото",
          invoice_button_text: `Получить фото • ${priceRequired} Stars`,
          payload_json: {
            action_kind: "photo_payment",
            chat_id: stats.chat_id,
            scene_session_id: stats.scene_session_id,
            turn_no: stats.turn_no,
            scene_turn_no: stats.scene_turn_no,
            media_signature: mediaSignature,
            target_message_id: null,
            current_uuid: null,
            base_price_xtr: basePrice,
            requested_action: "photo_request",
          },
        }),
      );

      const invoiceLink = normalizeString(storedInvoice?.invoice_link);
      const replyMarkup = invoiceLink
        ? appendInvoiceButton(
          { inline_keyboard: [] },
          String(storedInvoice?.invoice_button_text ?? `Получить фото • ${priceRequired} Stars`),
          invoiceLink,
        )
        : { inline_keyboard: [] };

      return {
        ...base,
        chat_id: stats.chat_id,
        scene_session_id: stats.scene_session_id,
        turn_no: stats.turn_no,
        scene_turn_no: stats.scene_turn_no,
        media_signature: mediaSignature,
        base_price_xtr: basePrice,
        price_required: priceRequired,
        operation: "prepare_offer_invoice_link",
        has_media_offer: true,
        reply_markup: replyMarkup,
        invoice_kind: "photo",
        invoice_sku: storedInvoice?.sku ?? null,
        invoice_amount: storedInvoice?.amount_xtr ?? priceRequired,
        invoice_title: storedInvoice?.invoice_title ?? "Фото",
        invoice_description:
          storedInvoice?.invoice_description ?? "Открыть фото для этого момента",
        invoice_label: storedInvoice?.invoice_label ?? "Фото",
        invoice_button_text:
          storedInvoice?.invoice_button_text ?? `Получить фото • ${priceRequired} Stars`,
        invoice_payload_json: {
          action_kind: "photo_payment",
          chat_id: stats.chat_id,
          scene_session_id: stats.scene_session_id,
          turn_no: stats.turn_no,
          scene_turn_no: stats.scene_turn_no,
          media_signature: mediaSignature,
          target_message_id: null,
          current_uuid: null,
          base_price_xtr: basePrice,
          requested_action: "photo_request",
        },
        invoice_token: storedInvoice?.token ?? null,
        invoice_link: invoiceLink,
        needs_invoice_link: invoiceLink == null,
        reason: invoiceLink ? "invoice_link_reused" : "invoice_link_required",
      };
    }

    const tokenRow = buildCallbackTokenRow({
      chat_id: stats.chat_id,
      scene_session_id: stats.scene_session_id,
      turn_no: stats.turn_no,
      scene_turn_no: stats.scene_turn_no,
      media_signature: mediaSignature,
      target_message_id: null,
      current_uuid: null,
      base_price_xtr: basePrice,
      next_action: "photo_request",
      requested_action: "photo_request",
    });
    const insertedCount = await this.repository.upsertCallbackTokens([tokenRow]);

    return {
      ...base,
      chat_id: stats.chat_id,
      scene_session_id: stats.scene_session_id,
      turn_no: stats.turn_no,
      scene_turn_no: stats.scene_turn_no,
      media_signature: mediaSignature,
      base_price_xtr: basePrice,
      price_required: 0,
      operation: "prepare_offer_callback",
      has_media_offer: true,
      token_rows: [tokenRow],
      token_rows_prepared: 1,
      token_rows_inserted: insertedCount,
      reply_markup: {
        inline_keyboard: [[{ text: "Получить фото", callback_data: tokenRow.token }]],
      },
      reason: "free_offer_ready",
    };
  }

  private async evaluateFinalizeOffer(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "finalize_offer");
    const chatId = normalizePositiveInteger(input.chat_id);
    if (!chatId) {
      return { ...base, reason: "chat_id_required" };
    }

    const result = await this.repository.storePanel({
      chat_id: chatId,
      scene_session_id: normalizeString(input.scene_session_id),
      turn_no: normalizeNonNegativeInteger(input.turn_no),
      scene_turn_no: normalizeNonNegativeInteger(input.scene_turn_no),
      media_signature: normalizeString(input.media_signature),
      panel_message_id: normalizePositiveInteger(input.panel_message_id),
      price_xtr: normalizeNonNegativeInteger(input.price_required) ?? 0,
      invoice_token: normalizeString(input.invoice_token),
      invoice_link: normalizeString(input.invoice_link),
      panel_text: normalizeString(input.panel_text),
      panel_entities_json: parseJsonArray(input.panel_entities_json) ?? [],
    });

    return {
      ...base,
      operation: "finalized_panel",
      chat_id: result.chat_id,
      turn_no: result.n,
      scene_session_id: result.scene_session_id,
      scene_turn_no: result.scene_turn_no,
      media_signature: result.media_signature,
      price_required: result.price_required,
      panel_message_id: result.panel_message_id,
      stored_count: result.stored_count,
      invoice_rows_updated: result.invoice_rows_updated,
      reason: result.stored_count > 0 ? "panel_stored" : "panel_already_stored",
    };
  }

  private async evaluateFeatureOffer(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "feature_offer");
    const chatId = normalizePositiveInteger(input.chat_id);
    if (!chatId) {
      return { ...base, reason: "chat_id_required" };
    }

    return {
      ...base,
      operation: "feature_offer_required",
      chat_id: chatId,
      reason: "feature_offer_required",
    };
  }

  private async evaluateCallback(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "callback");
    const token = normalizeString(input.callback_data);
    const chatId = normalizePositiveInteger(input.chat_id);
    const callbackRow = await this.repository.loadCallbackToken(
      token,
      chatId,
    );
    const payload = parseJsonObject(callbackRow?.payload_json) ?? {};
    const actionKind =
      normalizeString(callbackRow?.action_kind)
      ?? normalizeString(
        typeof payload.action_kind === "string" ? payload.action_kind : null,
      );
    const rawPanel = extractPanelFromRawUpdate(input.raw_update);
    const panelText = normalizeString(input.panel_text) ?? rawPanel.panel_text;
    const panelEntities =
      parseJsonArray(input.panel_entities_json) ?? rawPanel.panel_entities_json;

    const valid =
      Boolean(callbackRow?.found && callbackRow?.token)
      && !isExpired(callbackRow?.expires_at)
      && normalizeString(callbackRow?.status) === "active";
    const answerText = !valid
      ? "Кнопка устарела."
      : PHOTO_ACTIONS.has(String(actionKind))
        ? "Секунду, генерируем фото"
        : "";

    const callbackBase = {
      ...base,
      callback_valid: valid,
      callback_answer_text: answerText,
      callback_show_alert: false,
      chat_id:
        normalizePositiveInteger(callbackRow?.chat_id)
        ?? normalizePositiveInteger(payload.chat_id)
        ?? base.chat_id,
      scene_session_id:
        normalizeString(callbackRow?.scene_session_id)
        ?? normalizeString(
          typeof payload.scene_session_id === "string"
            ? payload.scene_session_id
            : null,
        )
        ?? base.scene_session_id,
      turn_no:
        normalizeNonNegativeInteger(payload.turn_no)
        ?? normalizeNonNegativeInteger(callbackRow?.turn_no)
        ?? base.turn_no,
      scene_turn_no:
        normalizeNonNegativeInteger(payload.scene_turn_no) ?? base.scene_turn_no,
      media_signature:
        normalizeString(
          typeof payload.media_signature === "string"
            ? payload.media_signature
            : null,
        ) ?? base.media_signature,
      target_message_id:
        normalizePositiveInteger(payload.target_message_id)
        ?? normalizePositiveInteger(input.inbound_message_id)
        ?? base.target_message_id,
      current_uuid:
        normalizeLowerString(
          typeof payload.current_uuid === "string" ? payload.current_uuid : null,
        ) ?? base.current_uuid,
      base_price_xtr:
        normalizePositiveInteger(payload.base_price_xtr) ?? base.base_price_xtr,
      panel_text: panelText,
      panel_entities_json: panelEntities,
    } satisfies MediaCommerceDecisionResponse;

    if (!valid || !callbackBase.chat_id) {
      return {
        ...callbackBase,
        operation: "noop",
        reason: valid ? "chat_id_required" : "callback_invalid",
      };
    }

    const context = await this.repository.loadMediaContext({
      chat_id: callbackBase.chat_id,
      scene_session_id: callbackBase.scene_session_id ?? null,
      turn_no: callbackBase.turn_no ?? null,
      scene_turn_no: callbackBase.scene_turn_no ?? null,
      media_signature: callbackBase.media_signature ?? null,
      current_uuid: callbackBase.current_uuid ?? null,
      target_message_id: callbackBase.target_message_id ?? null,
      base_price_xtr: callbackBase.base_price_xtr ?? 10,
      action_kind: actionKind,
      requested_action: normalizeString(
        typeof payload.requested_action === "string"
          ? payload.requested_action
          : null,
      ),
      invoice_token: null,
      force_deliver_after_payment: false,
      paid_access_mode: null,
      callback_valid: true,
      panel_text: panelText,
      panel_entities_json: panelEntities ?? [],
    });

    if (!context) {
      return {
        ...callbackBase,
        operation: "noop",
        reason: "media_context_not_found",
      };
    }

    return this.finalizeMediaActionResponse(callbackBase, context);
  }

  private async finalizeMediaActionResponse(
    base: MediaCommerceDecisionResponse,
    context: MediaContext,
  ): Promise<MediaCommerceDecisionResponse> {
    const decision = buildMediaAction(context);
    if (decision.operation === "noop") {
      return {
        ...base,
        operation: "noop",
        caption_text: decision.caption_text,
        caption_entities_json: decision.caption_entities_json,
        reason: "noop_media_action",
      };
    }

    const tokenRowsInserted = decision.token_rows.length > 0
      ? await this.repository.upsertCallbackTokens(decision.token_rows)
      : 0;

    let invoiceToken: StoredInvoiceToken | null = null;
    let replyMarkup = decision.reply_markup;
    let operation = decision.operation;

    if (
      decision.invoice_kind === "photo"
      && decision.invoice_amount
      && decision.invoice_title
      && decision.invoice_description
      && decision.invoice_label
      && decision.invoice_button_text
      && decision.invoice_payload_json
      && base.chat_id
    ) {
      invoiceToken = await this.repository.upsertInvoiceToken(
        buildPhotoInvoiceInput({
          chat_id: base.chat_id,
          scene_session_id: context.scene_session_id,
          turn_no: context.turn_no,
          scene_turn_no: context.scene_turn_no,
          media_signature: context.media_signature,
          target_message_id: context.target_message_id,
          current_uuid: decision.current_uuid,
          base_price_xtr: Number(context.base_price_xtr ?? 10),
          amount_xtr: decision.invoice_amount,
          invoice_title: decision.invoice_title,
          invoice_description: decision.invoice_description,
          invoice_label: decision.invoice_label,
          invoice_button_text: decision.invoice_button_text,
          payload_json: decision.invoice_payload_json,
        }),
      );

      const invoiceLink = normalizeString(invoiceToken?.invoice_link);
      if (invoiceLink) {
        replyMarkup = appendInvoiceButton(
          replyMarkup,
          String(
            invoiceToken?.invoice_button_text
              ?? decision.invoice_button_text
              ?? `Ещё фото • ${decision.invoice_amount} Stars`,
          ),
          invoiceLink,
        );
        operation = "edit_photo";
      }
    }

    return {
      ...base,
      operation,
      chat_id: context.chat_id,
      scene_session_id: context.scene_session_id,
      turn_no: context.turn_no,
      scene_turn_no: context.scene_turn_no,
      media_signature: context.media_signature,
      target_message_id: context.target_message_id,
      current_uuid: decision.current_uuid,
      photo_url: decision.photo_url,
      selected_uuid: decision.selected_uuid,
      reply_markup: replyMarkup,
      token_rows: decision.token_rows,
      token_rows_prepared: decision.token_rows.length,
      token_rows_inserted: tokenRowsInserted,
      log_event_type: decision.log_event_type,
      access_mode: decision.access_mode,
      log_price_xtr: decision.log_price_xtr,
      price_required: decision.price_required,
      invoice_kind: decision.invoice_kind,
      invoice_sku: invoiceToken?.sku ?? decision.invoice_sku,
      invoice_amount: invoiceToken?.amount_xtr ?? decision.invoice_amount,
      invoice_title: invoiceToken?.invoice_title ?? decision.invoice_title,
      invoice_description:
        invoiceToken?.invoice_description ?? decision.invoice_description,
      invoice_label: invoiceToken?.invoice_label ?? decision.invoice_label,
      invoice_payload_json: decision.invoice_payload_json,
      invoice_button_text:
        invoiceToken?.invoice_button_text ?? decision.invoice_button_text,
      invoice_token: invoiceToken?.token ?? null,
      invoice_link: normalizeString(invoiceToken?.invoice_link),
      needs_invoice_link:
        invoiceToken != null && normalizeString(invoiceToken.invoice_link) == null,
      fulfillment_invoice_token: decision.fulfillment_invoice_token,
      caption_text: decision.caption_text,
      caption_entities_json: decision.caption_entities_json,
      subscription_active: context.subscription_active,
      subscription_sku: context.subscription_sku,
      subscription_until: context.subscription_until,
      reason: operation === "edit_photo_with_invoice_link"
        ? "invoice_link_required"
        : "media_ready",
    };
  }

  private async evaluatePrecheckout(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "pre_checkout");
    const chatId = normalizePositiveInteger(input.chat_id);
    const invoicePayload = normalizeString(input.invoice_payload);
    if (!chatId || !invoicePayload) {
      return {
        ...base,
        operation: "answer_precheckout",
        precheckout_ok: false,
        precheckout_error: "Счёт больше не актуален.",
        reason: !chatId ? "chat_id_required" : "invoice_payload_required",
      };
    }

    const tokenRow = await this.repository.loadInvoiceToken(
      invoicePayload,
      chatId,
    );
    const payload = parseJsonObject(tokenRow?.payload_json) ?? {};
    const actionResolution = resolveInvoiceActionResult(
      payload,
      tokenRow?.action_kind,
    );

    let ok = true;
    let error = "";
    let reason = "precheckout_allowed";
    if (!tokenRow?.found || !tokenRow.token) {
      ok = false;
      error = "Счёт больше не актуален.";
      reason = "invoice_not_found";
    } else if (normalizeString(tokenRow.kind) !== INVOICE_PAYLOAD_KIND) {
      ok = false;
      error = "Счёт больше не актуален.";
      reason = "invoice_kind_invalid";
    } else if (actionResolution.reason != null) {
      ok = false;
      error = "Этот счёт больше не поддерживается.";
      reason = actionResolution.reason;
    } else if (isExpired(tokenRow.expires_at)) {
      ok = false;
      error = "Срок оплаты истёк.";
      reason = "invoice_expired";
    } else if (normalizeString(tokenRow.status) !== "invoice_sent") {
      ok = false;
      error = "Этот счёт уже недоступен.";
      reason = "invoice_status_invalid";
    } else if (
      !hasExpectedPaymentDetails(
        tokenRow.amount_xtr,
        normalizeString(input.payment_currency),
        normalizeNonNegativeInteger(input.payment_total_amount),
      )
    ) {
      ok = false;
      error = "Сумма счёта больше не совпадает.";
      reason = "payment_details_mismatch";
    }

    if (tokenRow?.token) {
      await this.repository.storePrecheckoutResult({
        token: tokenRow.token,
        pre_checkout_query_id: normalizeString(input.pre_checkout_query_id),
        ok,
        error_message: error || null,
      });
    }

    return {
      ...base,
      operation: "answer_precheckout",
      chat_id: normalizePositiveInteger(tokenRow?.chat_id) ?? base.chat_id,
      scene_session_id: tokenRow?.scene_session_id ?? base.scene_session_id,
      turn_no: normalizeNonNegativeInteger(tokenRow?.turn_no) ?? base.turn_no,
      payment_kind: actionResolution.action?.payment_kind ?? null,
      feature_key: actionResolution.action?.feature_key ?? null,
      precheckout_ok: ok,
      precheckout_error: error || null,
      reason: ok ? "precheckout_allowed" : reason,
    };
  }

  private async evaluatePaymentSuccess(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "payment_success");
    const chatId = normalizePositiveInteger(input.chat_id);
    const invoicePayload = normalizeString(input.invoice_payload);
    if (!chatId || !invoicePayload) {
      return {
        ...base,
        reason: !chatId ? "chat_id_required" : "invoice_payload_required",
      };
    }

    const loaded = await this.repository.loadInvoiceToken(invoicePayload, chatId);
    if (!loaded?.found || !loaded.token) {
      return { ...base, reason: "invoice_not_found" };
    }

    if (normalizeString(loaded.kind) !== INVOICE_PAYLOAD_KIND) {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        reason: "invoice_kind_invalid",
      };
    }

    const payload = parseJsonObject(loaded.payload_json) ?? {};
    const actionResolution = resolveInvoiceActionResult(payload, loaded.action_kind);
    if (actionResolution.reason != null || !actionResolution.action) {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        reason: actionResolution.reason ?? "invoice_action_kind_invalid",
      };
    }

    const existingStatus = normalizeString(loaded.status);
    if (
      !hasExpectedPaymentDetails(
        loaded.amount_xtr,
        normalizeString(input.payment_currency),
        normalizeNonNegativeInteger(input.payment_total_amount),
      )
    ) {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_kind: actionResolution.action.payment_kind,
        feature_key: actionResolution.action.feature_key,
        reason: "payment_details_mismatch",
      };
    }

    if (existingStatus === "fulfilled") {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_kind: actionResolution.action.payment_kind,
        payment_token: loaded.token,
        feature_key: actionResolution.action.feature_key,
        reason: "payment_already_fulfilled",
      };
    }

    let paidRow: PaidInvoiceToken | null = null;
    if (existingStatus === "paid") {
      paidRow = toPaidInvoiceToken(loaded);
    } else if (existingStatus === "invoice_sent") {
      paidRow = await this.repository.markInvoicePaid({
        token: loaded.token,
        chat_id: chatId,
        expected_kind: INVOICE_PAYLOAD_KIND,
        expected_action_kind: actionResolution.action.action_kind,
        telegram_payment_charge_id: normalizeString(
          input.telegram_payment_charge_id,
        ),
        provider_payment_charge_id: normalizeString(
          input.provider_payment_charge_id,
        ),
        payment_currency: normalizeString(input.payment_currency),
        payment_total_amount: normalizeNonNegativeInteger(
          input.payment_total_amount,
        ),
      });

      if (!paidRow) {
        const reloaded = await this.repository.loadInvoiceToken(invoicePayload, chatId);
        const reloadedStatus = normalizeString(reloaded?.status);
        if (reloadedStatus === "fulfilled") {
          return {
            ...base,
            chat_id: normalizePositiveInteger(reloaded?.chat_id) ?? base.chat_id,
            scene_session_id: reloaded?.scene_session_id ?? base.scene_session_id,
            turn_no: normalizeNonNegativeInteger(reloaded?.turn_no) ?? base.turn_no,
            payment_kind: actionResolution.action.payment_kind,
            payment_token: normalizeString(reloaded?.token),
            feature_key: actionResolution.action.feature_key,
            reason: "payment_already_fulfilled",
          };
        }
        if (reloadedStatus === "paid" && reloaded) {
          paidRow = toPaidInvoiceToken(reloaded);
        }
      }
    } else {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_kind: actionResolution.action.payment_kind,
        feature_key: actionResolution.action.feature_key,
        reason: "invoice_status_invalid",
      };
    }

    if (!paidRow) {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_kind: actionResolution.action.payment_kind,
        feature_key: actionResolution.action.feature_key,
        reason: "payment_not_claimed",
      };
    }

    if (actionResolution.action.payment_kind === "subscription") {
      const subscriptionDays = actionResolution.action.subscription_days;
      const subscriptionSku =
        actionResolution.action.subscription_sku
        ?? normalizeString(paidRow.sku);
      if (subscriptionDays <= 0 || !subscriptionSku) {
        return {
          ...base,
          chat_id: paidRow.chat_id,
          scene_session_id: paidRow.scene_session_id,
          turn_no: paidRow.turn_no,
          payment_kind: "subscription",
          payment_token: paidRow.token,
          reason: "invoice_action_kind_invalid",
        };
      }

      const activatedCount = await this.repository.activateSubscription({
        payment_token: paidRow.token,
        chat_id: paidRow.chat_id,
        subscription_sku: subscriptionSku,
        subscription_days: subscriptionDays,
      });

      if (activatedCount <= 0) {
        return {
          ...base,
          chat_id: paidRow.chat_id,
          scene_session_id: paidRow.scene_session_id,
          turn_no: paidRow.turn_no,
          payment_kind: "subscription",
          payment_token: paidRow.token,
          subscription_days: subscriptionDays,
          subscription_sku: subscriptionSku,
          offer_message_id: normalizePositiveInteger(
            paidRow.telegram_invoice_message_id,
          ),
          reason: "subscription_already_activated",
        };
      }

      return {
        ...base,
        operation: "subscription_activated",
        chat_id: paidRow.chat_id,
        scene_session_id: paidRow.scene_session_id,
        turn_no: paidRow.turn_no,
        payment_kind: "subscription",
        payment_token: paidRow.token,
        subscription_days: subscriptionDays,
        subscription_sku: subscriptionSku,
        offer_message_id: normalizePositiveInteger(
          paidRow.telegram_invoice_message_id,
        ),
        stored_count: activatedCount,
        reason: "subscription_activated",
      };
    }

    if (actionResolution.action.payment_kind === "feature") {
      return {
        ...base,
        operation: "feature_fulfillment_required",
        chat_id:
          normalizePositiveInteger(payload.chat_id)
          ?? paidRow.chat_id,
        scene_session_id: normalizeString(
          typeof payload.scene_session_id === "string"
            ? payload.scene_session_id
            : paidRow.scene_session_id,
        ),
        turn_no:
          normalizeNonNegativeInteger(payload.turn_no)
          ?? normalizeNonNegativeInteger(paidRow.turn_no),
        scene_turn_no: normalizeNonNegativeInteger(payload.scene_turn_no),
        character_i: normalizePositiveInteger(payload.character_i),
        scene_mode: normalizeString(
          typeof payload.scene_mode === "string"
            ? payload.scene_mode
            : null,
        ),
        media_signature: normalizeString(
          typeof payload.media_signature === "string"
            ? payload.media_signature
            : null,
        ),
        target_message_id: normalizePositiveInteger(payload.target_message_id),
        payment_kind: "feature",
        payment_token: paidRow.token,
        feature_key: actionResolution.action.feature_key,
        reason: `feature_${actionResolution.action.feature_key}_fulfillment_required`,
      };
    }

    const context = await this.repository.loadMediaContext({
      chat_id:
        normalizePositiveInteger(
          payload.chat_id,
        )
        ?? paidRow.chat_id,
      scene_session_id: normalizeString(
        typeof payload.scene_session_id === "string"
          ? payload.scene_session_id
          : paidRow.scene_session_id,
      ),
      turn_no:
        normalizeNonNegativeInteger(payload.turn_no)
        ?? normalizeNonNegativeInteger(paidRow.turn_no),
      scene_turn_no: normalizeNonNegativeInteger(payload.scene_turn_no),
      media_signature: normalizeString(
        typeof payload.media_signature === "string"
          ? payload.media_signature
          : null,
      ),
      current_uuid: normalizeLowerString(
        typeof payload.current_uuid === "string" ? payload.current_uuid : null,
      ),
      target_message_id:
        normalizePositiveInteger(paidRow.telegram_invoice_message_id)
        ?? normalizePositiveInteger(payload.target_message_id),
      base_price_xtr:
        normalizePositiveInteger(payload.base_price_xtr)
        ?? normalizePositiveInteger(paidRow.amount_xtr)
        ?? 10,
      action_kind:
        normalizeString(
          typeof payload.requested_action === "string"
            ? payload.requested_action
            : null,
        ) ?? "photo_request",
      requested_action:
        normalizeString(
          typeof payload.requested_action === "string"
            ? payload.requested_action
            : null,
        ) ?? "photo_request",
      invoice_token: paidRow.token,
      force_deliver_after_payment: true,
      paid_access_mode: "paid",
      callback_valid: true,
      panel_text: normalizeString(
        typeof payload.panel_text === "string" ? payload.panel_text : null,
      ),
      panel_entities_json:
        parseJsonArray(payload.panel_entities_json) ?? [],
    });

    if (!context) {
      return {
        ...base,
        chat_id: paidRow.chat_id,
        scene_session_id: paidRow.scene_session_id,
        turn_no: paidRow.turn_no,
        payment_kind: "photo",
        payment_token: paidRow.token,
        reason: "media_context_not_found",
      };
    }

    const response = await this.finalizeMediaActionResponse(
      {
        ...base,
        callback_valid: true,
        chat_id: context.chat_id,
        scene_session_id: context.scene_session_id,
        turn_no: context.turn_no,
        scene_turn_no: context.scene_turn_no,
        media_signature: context.media_signature,
        target_message_id: context.target_message_id,
        current_uuid: context.current_uuid,
        base_price_xtr: context.base_price_xtr,
        panel_text: context.panel_text,
        panel_entities_json: parseJsonArray(context.panel_entities_json),
        payment_kind: "photo",
        payment_token: paidRow.token,
      },
      context,
    );

    return {
      ...response,
      payment_kind: "photo",
      payment_token: paidRow.token,
    };
  }

  private async evaluateSubscriptionOffer(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "subscription_offer");
    const chatId = normalizePositiveInteger(input.chat_id);
    if (!chatId) {
      return { ...base, reason: "chat_id_required" };
    }

    const subscriptionOfferReason =
      input.subscription_offer_reason === "daily_turn_limit"
      || input.subscription_offer_reason === "subscription_command"
        ? input.subscription_offer_reason
        : null;
    const idempotencyKey =
      normalizeString(input.idempotency_key)
      ?? `telegram:chat:${chatId}`;
    const turnLimit = normalizePositiveInteger(input.turn_limit) ?? config.TURN_LIMIT;
    const turnsToday =
      normalizeNonNegativeInteger(input.turns_today) ?? turnLimit;
    const turnLimitResetText =
      normalizeString(input.turn_limit_reset_text) ?? config.TURN_LIMIT_RESET_TEXT;

    const upsertedRows: StoredInvoiceToken[] = [];
    for (const plan of config.MEDIA_SUBSCRIPTION_PLANS_JSON) {
      const row = await this.repository.upsertInvoiceToken(
        buildSubscriptionInvoiceInput({
          chat_id: chatId,
          idempotency_key: idempotencyKey,
          subscription_offer_reason: subscriptionOfferReason,
          turn_limit: turnLimit,
          turns_today: turnsToday,
          turn_limit_reset_text: turnLimitResetText,
          plan,
        }),
      );
      if (row) {
        upsertedRows.push(row);
      }
    }

    const createdLinks = input.created_invoice_links ?? [];
    if (createdLinks.length > 0) {
      const linkRows = createdLinks
        .map((item) => {
          const token = normalizeString(item.token);
          const invoiceLink = normalizeString(item.invoice_link);
          const sourceRow = token
            ? upsertedRows.find((row) => row.token === token)
            : undefined;
          if (!token || !invoiceLink || !sourceRow) {
            return null;
          }
          return {
            token,
            chat_id: sourceRow.chat_id,
            invoice_link: invoiceLink,
          };
        })
        .filter(
          (
            row,
          ): row is { token: string; chat_id: number; invoice_link: string } =>
            row != null,
        );

      if (linkRows.length > 0) {
        await this.repository.storeInvoiceLinks(linkRows);
      }
    }

    const tokenList = upsertedRows.map((row) => row.token);
    const storedRows = tokenList.length > 0
      ? mergeStoredRowsWithMetadata(
        await this.repository.loadStoredInvoiceTokens(tokenList),
        upsertedRows,
      )
      : upsertedRows;

    const rows = storedRows.length > 0 ? storedRows : upsertedRows;
    const missingRows = rows.filter(
      (row) => normalizeString(row.invoice_link) == null,
    );

    if (missingRows.length > 0) {
      return {
        ...base,
        operation: "subscription_offer_links_needed",
        chat_id: chatId,
        missing_invoice_links: true,
        missing_invoice_link_count: missingRows.length,
        missing_invoice_items: missingRows.map((row) => ({
          token: row.token,
          telegram_invoice_payload: String(row.telegram_invoice_payload ?? row.token),
          amount_xtr: Number(row.amount_xtr ?? 0),
          invoice_title: row.invoice_title,
          invoice_description: row.invoice_description,
          invoice_label: row.invoice_label,
          invoice_button_text: row.invoice_button_text,
        })),
        subscription_invoice_tokens: tokenList,
        subscription_offer_reason: subscriptionOfferReason,
        turn_limit: turnLimit,
        turns_today: turnsToday,
        turn_limit_reset_text: turnLimitResetText,
        reason: "subscription_invoice_links_required",
      };
    }

    const message = buildSubscriptionOfferMessage(rows);
    return {
      ...base,
      operation: "subscription_offer_ready",
      chat_id: chatId,
      text: message.text,
      reply_markup: message.reply_markup,
      offer_message_id: message.offer_message_id,
      offer_sent: false,
      offer_reused: message.offer_message_id != null,
      subscription_offer_reason: message.offer_reason,
      turn_limit: message.turn_limit,
      turns_today: message.turns_today,
      turn_limit_reset_text: message.turn_limit_reset_text,
      subscription_invoice_tokens: message.subscription_invoice_tokens,
      missing_invoice_links: false,
      missing_invoice_link_count: 0,
      reason:
        message.offer_message_id != null
          ? "subscription_offer_reused"
          : "subscription_offer_ready",
    };
  }

  private async evaluateFinalizePhotoEvent(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "finalize_photo_event");
    const chatId = normalizePositiveInteger(input.chat_id);
    if (!chatId) {
      return { ...base, reason: "chat_id_required" };
    }

    const result = await this.repository.storePhotoEvent({
      chat_id: chatId,
      scene_session_id: normalizeString(input.scene_session_id),
      turn_no: normalizeNonNegativeInteger(input.turn_no),
      scene_turn_no: normalizeNonNegativeInteger(input.scene_turn_no),
      event_type: normalizeString(input.log_event_type),
      media_signature: normalizeString(input.media_signature),
      uuid: normalizeLowerString(input.selected_uuid),
      panel_message_id:
        normalizePositiveInteger(input.panel_message_id)
        ?? normalizePositiveInteger(input.target_message_id),
      price_xtr: normalizeNonNegativeInteger(input.log_price_xtr) ?? 0,
      access_mode: normalizeString(input.access_mode),
      action_kind: normalizeString(input.action_kind),
      fulfillment_invoice_token: normalizeString(input.fulfillment_invoice_token),
      next_invoice_token: normalizeString(input.invoice_token),
      next_invoice_link: normalizeString(input.invoice_link),
      price_required: normalizeNonNegativeInteger(input.price_required) ?? 0,
    });

    return {
      ...base,
      operation: "photo_event_stored",
      chat_id: result.chat_id,
      turn_no: result.n,
      scene_session_id: result.scene_session_id,
      scene_turn_no: result.scene_turn_no,
      media_signature: result.media_signature,
      panel_message_id: result.panel_message_id,
      price_required: result.price_required,
      stored_count: result.stored_count,
      invoice_rows_updated: result.invoice_rows_updated,
      reason: result.stored_count > 0 ? "photo_event_stored" : "photo_event_skipped",
    };
  }

  private async evaluateFinalizeSubscriptionOffer(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input, "finalize_subscription_offer");
    const chatId = normalizePositiveInteger(input.chat_id);
    const offerMessageId = normalizePositiveInteger(input.offer_message_id);
    const tokens = (input.subscription_invoice_tokens ?? [])
      .map((token) => normalizeString(token))
      .filter((token): token is string => token != null);

    if (!chatId || !offerMessageId || tokens.length === 0) {
      return { ...base, reason: "finalize_subscription_offer_input_invalid" };
    }

    const updatedCount = await this.repository.storeSubscriptionOfferMessageId(
      tokens,
      chatId,
      offerMessageId,
    );

    return {
      ...base,
      operation: "subscription_offer_finalized",
      chat_id: chatId,
      offer_message_id: offerMessageId,
      subscription_invoice_tokens: tokens,
      offer_sent: updatedCount > 0,
      offer_reused: false,
      stored_count: updatedCount,
      reason:
        updatedCount > 0
          ? "subscription_offer_message_stored"
          : "subscription_offer_message_already_stored",
    };
  }
}
