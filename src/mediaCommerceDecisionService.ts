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
  type ResolvedInvoiceAction,
  resolveInvoiceActionResult,
  toPaidInvoiceToken,
  validatePrecheckout,
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
  resolveSubscriptionPlans,
  resolveActionPlanByFeatureKey,
  resolvePhotoPlanByAmount,
} from "./mediaCommerce/plans.js";
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
import { sql } from "./db.js";
import type { MediaCommerceDecisionRequest } from "./mediaCommerce/requestSchema.js";
import { getRequestContext } from "./requestContext.js";
import type {
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

type SubscriptionPaymentAction = Extract<
  ResolvedInvoiceAction,
  { payment_kind: "subscription" }
>;

type FeaturePaymentAction = Extract<
  ResolvedInvoiceAction,
  { payment_kind: "feature" }
>;

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

function extractErrorCode(error: unknown): string | null {
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

function toOperationError(operation: string, error: unknown): MediaCommerceOperationError {
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

type RepositoryOperationLogContext = {
  chat_id?: number | null;
  payment_kind?: string | null;
  sku?: string | null;
  invoice_status?: string | null;
  input_is_array?: boolean;
  input_length?: number | null;
};

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

  private async runRepositoryOperation<T>(
    operation: string,
    context: RepositoryOperationLogContext,
    execute: () => Promise<T>,
  ): Promise<T> {
    const requestId = getRequestContext()?.requestId ?? null;
    const startedAt = Date.now();

    console.info(`[media_commerce] ${operation}`, {
      request_id: requestId,
      operation,
      status: "start",
      ...context,
    });

    try {
      const result = await execute();
      console.info(`[media_commerce] ${operation}`, {
        request_id: requestId,
        operation,
        status: "success",
        duration_ms: Date.now() - startedAt,
        ...context,
      });
      return result;
    } catch (error) {
      const operationError = toOperationError(operation, error);
      console.error(`[media_commerce] ${operation}`, {
        request_id: requestId,
        operation,
        status: "error",
        duration_ms: Date.now() - startedAt,
        ...context,
        code: operationError.code,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      throw operationError;
    }
  }

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

    return this.resolvePrepareOffer(base, stats);
  }

  private async resolvePrepareOffer(
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
      const photoPlan = resolvePhotoPlanByAmount(priceRequired);
      const invoicePayload = {
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
        original_amount_xtr: photoPlan.original_amount_xtr,
        promo_key: photoPlan.promo_key,
      } satisfies Record<string, unknown>;

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
          amount_xtr: photoPlan.amount_xtr,
          original_amount_xtr: photoPlan.original_amount_xtr,
          promo_key: photoPlan.promo_key,
          invoice_sku: photoPlan.sku,
          invoice_title: photoPlan.title,
          invoice_description: photoPlan.description,
          invoice_label: photoPlan.label,
          invoice_button_text: photoPlan.button_text,
          payload_json: invoicePayload,
        }),
      );

      const invoiceLink = normalizeString(storedInvoice?.invoice_link);
      const replyMarkup = invoiceLink
        ? appendInvoiceButton(
          { inline_keyboard: [] },
          String(storedInvoice?.invoice_button_text ?? photoPlan.button_text),
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
        invoice_sku: storedInvoice?.sku ?? photoPlan.sku,
        invoice_amount: storedInvoice?.amount_xtr ?? photoPlan.amount_xtr,
        original_invoice_amount:
          normalizePositiveInteger(storedInvoice?.payload_json.original_amount_xtr)
          ?? photoPlan.original_amount_xtr,
        promo_key:
          normalizeString(
            typeof storedInvoice?.payload_json.promo_key === "string"
              ? storedInvoice.payload_json.promo_key
              : null,
          )
          ?? photoPlan.promo_key,
        invoice_title: storedInvoice?.invoice_title ?? photoPlan.title,
        invoice_description:
          storedInvoice?.invoice_description ?? photoPlan.description,
        invoice_label: storedInvoice?.invoice_label ?? photoPlan.label,
        invoice_button_text:
          storedInvoice?.invoice_button_text ?? photoPlan.button_text,
        invoice_payload_json: invoicePayload,
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

    const featureKey = normalizeString(input.feature_key) ?? "fast_scene_skip";
    const actionPlan = resolveActionPlanByFeatureKey(featureKey);

    return {
      ...base,
      operation: "feature_offer_required",
      chat_id: chatId,
      feature_key: featureKey,
      invoice_kind: actionPlan ? "feature" : null,
      invoice_sku: actionPlan?.sku ?? null,
      invoice_amount: actionPlan?.amount_xtr ?? null,
      original_invoice_amount: actionPlan?.original_amount_xtr ?? null,
      promo_key: actionPlan?.promo_key ?? null,
      invoice_title: actionPlan?.title ?? null,
      invoice_description: actionPlan?.description ?? null,
      invoice_label: actionPlan?.label ?? null,
      invoice_button_text: actionPlan?.button_text ?? null,
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

    return this.applyMediaActionDecision(callbackBase, context);
  }

  private async applyMediaActionDecision(
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
      && decision.invoice_sku
      && decision.invoice_amount
      && decision.original_invoice_amount
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
          original_amount_xtr: decision.original_invoice_amount,
          promo_key: decision.promo_key,
          invoice_sku: decision.invoice_sku,
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
      original_invoice_amount:
        normalizePositiveInteger(invoiceToken?.payload_json.original_amount_xtr)
        ?? decision.original_invoice_amount,
      promo_key:
        normalizeString(
          typeof invoiceToken?.payload_json.promo_key === "string"
            ? invoiceToken.payload_json.promo_key
            : null,
        )
        ?? decision.promo_key,
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

    const tokenRow = await this.runRepositoryOperation(
      "payment.precheckout.loadInvoiceToken",
      {
        chat_id: chatId,
        payment_kind: null,
        sku: null,
        invoice_status: null,
      },
      () => this.repository.loadInvoiceToken(invoicePayload, chatId),
    );
    const validation = validatePrecheckout(
      tokenRow,
      normalizeString(input.payment_currency),
      normalizeNonNegativeInteger(input.payment_total_amount),
    );

    if (tokenRow?.token != null) {
      const token = tokenRow.token;
      await this.runRepositoryOperation(
        "payment.precheckout.storePrecheckoutResult",
        {
          chat_id: normalizePositiveInteger(tokenRow.chat_id) ?? chatId,
          payment_kind: validation.action?.payment_kind ?? null,
          sku: normalizeString(tokenRow.sku),
          invoice_status: normalizeString(tokenRow.status),
        },
        () => this.repository.storePrecheckoutResult({
          token,
          pre_checkout_query_id: normalizeString(input.pre_checkout_query_id),
          ok: validation.ok,
          error_message: validation.error,
        }),
      );
    }

    return {
      ...base,
      operation: "answer_precheckout",
      chat_id: normalizePositiveInteger(tokenRow?.chat_id) ?? base.chat_id,
      scene_session_id: tokenRow?.scene_session_id ?? base.scene_session_id,
      turn_no: normalizeNonNegativeInteger(tokenRow?.turn_no) ?? base.turn_no,
      payment_kind: validation.action?.payment_kind ?? null,
      feature_key: validation.action?.feature_key ?? null,
      precheckout_ok: validation.ok,
      precheckout_error: validation.error,
      reason: validation.reason,
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

    const loaded = await this.runRepositoryOperation(
      "payment.success.loadInvoiceToken",
      {
        chat_id: chatId,
        payment_kind: null,
        sku: null,
        invoice_status: null,
      },
      () => this.repository.loadInvoiceToken(invoicePayload, chatId),
    );
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
    const resolvedAction = actionResolution.action;

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
        payment_kind: resolvedAction.payment_kind,
        feature_key: resolvedAction.feature_key,
        reason: "payment_details_mismatch",
      };
    }

    if (existingStatus === "fulfilled") {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_kind: resolvedAction.payment_kind,
        payment_token: loaded.token,
        feature_key: resolvedAction.feature_key,
        reason: "payment_already_fulfilled",
      };
    }

    let paidRow: PaidInvoiceToken | null = null;
    if (existingStatus === "paid") {
      paidRow = toPaidInvoiceToken(loaded);
    } else if (existingStatus === "invoice_sent") {
      const loadedToken = loaded.token;
      paidRow = await this.runRepositoryOperation(
        "payment.success.markInvoicePaid",
        {
          chat_id: chatId,
          payment_kind: resolvedAction.payment_kind,
          sku: normalizeString(loaded.sku),
          invoice_status: existingStatus,
        },
        () => this.repository.markInvoicePaid({
          token: loadedToken,
          chat_id: chatId,
          expected_kind: INVOICE_PAYLOAD_KIND,
          expected_action_kind: resolvedAction.action_kind,
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
        }),
      );

      if (!paidRow) {
        const reloaded = await this.runRepositoryOperation(
          "payment.success.reloadInvoiceToken",
          {
            chat_id: chatId,
            payment_kind: actionResolution.action.payment_kind,
            sku: normalizeString(loaded.sku),
            invoice_status: existingStatus,
          },
          () => this.repository.loadInvoiceToken(invoicePayload, chatId),
        );
        const reloadedStatus = normalizeString(reloaded?.status);
        if (reloadedStatus === "fulfilled") {
          return {
            ...base,
            chat_id: normalizePositiveInteger(reloaded?.chat_id) ?? base.chat_id,
            scene_session_id: reloaded?.scene_session_id ?? base.scene_session_id,
            turn_no: normalizeNonNegativeInteger(reloaded?.turn_no) ?? base.turn_no,
            payment_kind: resolvedAction.payment_kind,
            payment_token: normalizeString(reloaded?.token),
            feature_key: resolvedAction.feature_key,
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
        payment_kind: resolvedAction.payment_kind,
        feature_key: resolvedAction.feature_key,
        reason: "invoice_status_invalid",
      };
    }

    if (!paidRow) {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_kind: resolvedAction.payment_kind,
        feature_key: resolvedAction.feature_key,
        reason: "payment_not_claimed",
      };
    }

    if (resolvedAction.payment_kind === "subscription") {
      return this.fulfillSubscriptionPayment(
        base,
        paidRow,
        resolvedAction,
      );
    }

    if (resolvedAction.payment_kind === "feature") {
      return this.buildFeatureFulfillmentResponse(
        base,
        paidRow,
        payload,
        resolvedAction,
      );
    }

    return this.fulfillPhotoPayment(base, paidRow, payload);
  }

  private async fulfillSubscriptionPayment(
    base: MediaCommerceDecisionResponse,
    paidRow: PaidInvoiceToken,
    action: SubscriptionPaymentAction,
  ): Promise<MediaCommerceDecisionResponse> {
    const subscriptionDays = action.subscription_days;
    const subscriptionSku = action.subscription_sku ?? normalizeString(paidRow.sku);
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

    const activatedCount = await this.runRepositoryOperation(
      "payment.subscription.activateSubscription",
      {
        chat_id: paidRow.chat_id,
        payment_kind: "subscription",
        sku: subscriptionSku,
        invoice_status: paidRow.status,
      },
      () => this.repository.activateSubscription({
        payment_token: paidRow.token,
        chat_id: paidRow.chat_id,
        subscription_sku: subscriptionSku,
        subscription_days: subscriptionDays,
      }),
    );

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

  private buildFeatureFulfillmentResponse(
    base: MediaCommerceDecisionResponse,
    paidRow: PaidInvoiceToken,
    payload: Record<string, unknown>,
    action: FeaturePaymentAction,
  ): MediaCommerceDecisionResponse {
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
      feature_key: action.feature_key,
      reason: `feature_${action.feature_key}_fulfillment_required`,
    };
  }

  private async fulfillPhotoPayment(
    base: MediaCommerceDecisionResponse,
    paidRow: PaidInvoiceToken,
    payload: Record<string, unknown>,
  ): Promise<MediaCommerceDecisionResponse> {
    const requestedAction =
      normalizeString(
        typeof payload.requested_action === "string"
          ? payload.requested_action
          : null,
      ) ?? "photo_request";

    const mediaContextInput = {
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
      action_kind: requestedAction,
      requested_action: requestedAction,
      invoice_token: paidRow.token,
      force_deliver_after_payment: true,
      paid_access_mode: "paid" as const,
      callback_valid: true,
      panel_text: normalizeString(
        typeof payload.panel_text === "string" ? payload.panel_text : null,
      ),
      panel_entities_json:
        parseJsonArray(payload.panel_entities_json) ?? [],
    };
    const context = await this.runRepositoryOperation(
      "payment.photo.loadMediaContext",
      {
        chat_id: mediaContextInput.chat_id,
        payment_kind: "photo",
        sku: normalizeString(paidRow.sku),
        invoice_status: paidRow.status,
      },
      () => this.repository.loadMediaContext(mediaContextInput),
    );

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

    const response = await this.applyMediaActionDecision(
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
    for (const plan of resolveSubscriptionPlans()) {
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
        const storeInvoiceLinksProbe = await sql<Array<{ input_type: string | null }>>`
          SELECT jsonb_typeof(${JSON.stringify(linkRows)}::jsonb) AS input_type
        `;
        await this.runRepositoryOperation(
          "subscription.storeInvoiceLinks",
          {
            chat_id: chatId,
            input_is_array: Array.isArray(linkRows),
            input_length: linkRows.length,
          },
          async () => {
            console.info("[subscription_offer] storeInvoiceLinks input_type", {
              request_id: getRequestContext()?.requestId ?? null,
              operation: "subscription.storeInvoiceLinks",
              status: "probe",
              chat_id: chatId,
              input_type: storeInvoiceLinksProbe[0]?.input_type ?? null,
            });
            return this.repository.storeInvoiceLinks(linkRows);
          },
        );
      }
    }

    const tokenList = upsertedRows.map((row) => row.token);
    const loadStoredInvoiceTokensProbe = await sql<Array<{ input_type: string | null }>>`
      SELECT jsonb_typeof(${JSON.stringify(tokenList)}::jsonb) AS input_type
    `;
    const storedRows = tokenList.length > 0
      ? mergeStoredRowsWithMetadata(
        await this.runRepositoryOperation(
          "subscription.loadStoredInvoiceTokens",
          {
            chat_id: chatId,
            input_is_array: Array.isArray(tokenList),
            input_length: tokenList.length,
          },
          async () => {
            console.info("[subscription_offer] loadStoredInvoiceTokens input_type", {
              request_id: getRequestContext()?.requestId ?? null,
              operation: "subscription.loadStoredInvoiceTokens",
              status: "probe",
              chat_id: chatId,
              input_type: loadStoredInvoiceTokensProbe[0]?.input_type ?? null,
            });
            return this.repository.loadStoredInvoiceTokens(tokenList);
          },
        ),
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
          original_amount_xtr:
            normalizePositiveInteger(row.payload_json.original_amount_xtr) ?? null,
          promo_key:
            normalizeString(
              typeof row.payload_json.promo_key === "string"
                ? row.payload_json.promo_key
                : null,
            ) ?? null,
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
        subscription_offer_items: rows.map((row) => ({
          token: row.token,
          sku: row.sku,
          subscription_days:
            normalizePositiveInteger(row.payload_json.subscription_days) ?? null,
          invoice_link: normalizeString(row.invoice_link),
          amount_xtr: Number(row.amount_xtr ?? 0),
          original_amount_xtr:
            normalizePositiveInteger(row.payload_json.original_amount_xtr) ?? null,
          promo_key:
            normalizeString(
              typeof row.payload_json.promo_key === "string"
                ? row.payload_json.promo_key
                : null,
            ) ?? null,
          invoice_title: row.invoice_title,
          invoice_description: row.invoice_description,
          invoice_label: row.invoice_label,
          invoice_button_text: row.invoice_button_text,
        })),
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
      subscription_offer_items: message.offer_items,
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

    const updatedCount = await this.runRepositoryOperation(
      "subscription.storeOfferMessageId",
      {
        chat_id: chatId,
        input_is_array: Array.isArray(tokens),
        input_length: tokens.length,
      },
      () => this.repository.storeSubscriptionOfferMessageId(
        tokens,
        chatId,
        offerMessageId,
      ),
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
