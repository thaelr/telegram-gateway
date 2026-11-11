import { normalizeInvoiceTokens, getSourceSortOrder, buildPaymentOption, buildOfferItem, groupOfferItems, getFirstAvailablePaymentSource, selectLegacyPrimaryRow, buildTopLevelPaymentFields, renderUx, sourcePhotoUrl, videoPaymentCleanupUrls, deliveryResponse, paymentOptionPrices } from './mediaCommerce/paymentResponses.js';
import { createHash, randomUUID } from 'node:crypto';
import { VideoCommerceRepository } from '../modules/media/videoRepository.js';
import type { VideoContext, VideoDelivery, VideoUi } from '../modules/media/videoRepository.js';
import { signVideoUrl } from '../videoStorage.js';
import type { WebProductPlan } from '../web/commerceTypes.js';
import { toAbTestContext } from '../modules/experiments/abTesting.js';
import type { AbTestContext, AbTestSelection, SubscriptionOfferExperimentParams } from '../modules/experiments/abTesting.js';
import { config } from '../config.js';
import { getMediaLanguage, getMediaCommerceCopy, getMediaPaymentMethods, getMediaUxCopy, runWithMediaLocalization } from '../mediaLocalization.js';
import { normalizeUnlockedItems, buildCallbackTokenRow, buildMediaAction, normalizeNextUnseen } from '../modules/media/mediaAction.js';
import { buildPhotoInvoiceInput } from '../modules/commerce/photoInvoice.js';
import { calculateMediaPriceRequired } from '../modules/access/actionEligibility.js';
import { normalizeFeatureKeyValue, normalizePaymentSource } from '../modules/commerce/paymentFlow.js';
import { buildBaseResponse } from './mediaCommerce/responseBuilders.js';
import { buildFeaturePaymentInputs, buildSceneUnlockPaymentInputs, buildSubscriptionPaymentInputs, buildPaymentInputs, getPaymentPrices } from '../modules/commerce/subscriptionFlow.js';
import { resolveSubscriptionPlans, resolveActionPlanByFeatureKey, resolvePhotoPlanBySku, calculateFullUpgrade, resolveVideoPassPlan } from '../modules/products/plans.js';
import { INVOICE_TTL_MS, extractPanelFromRawUpdate, isExpired, normalizeBoolean, normalizeLowerString, normalizeNonNegativeInteger, normalizePositiveInteger, normalizeString, parseJsonArray, parseJsonObject } from '../mediaCommerce/utils.js';
import type { MediaCommerceDecisionRequest } from '../mediaCommerce/requestSchema.js';
import { formatFreeBalances } from '../freeBalanceFormatter.js';
import { TelegramStarsPaymentAdapter } from '../payments/stars.js';
import type { StarsInvoiceClient } from '../payments/stars.js';
import { SbpPaymentAdapter } from '../payments/sbp.js';
import type { SbpPaymentClient } from '../payments/sbp.js';
import type { CommerceUi, CommerceSurface, CommerceProduct, MediaCommerceDecisionResponse, MediaCommerceRoute, InteractionTokenRow, MediaContext, MediaPaymentOption, MediaSubscriptionOfferReason, MediaOfferStats, PaymentUiCopy, PaymentSource, StoredInvoiceToken } from '../mediaCommerceTypes.js';
import { MediaCommerceOperationError, runRepositoryOperation } from '../mediaCommerce/operations.js';
import { getInvoicePurchaseId, getInvoiceFeatureKey, buildPurchaseGroupKey, buildSbpGatewayRow, upsertCurrentPaymentAttempts, resolveSbpCheckout, prepareRenderablePaymentRows } from '../modules/commerce/checkout.js';
import { applySubscriptionPlanOverrides, applySceneUnlockOverride } from '../modules/products/planOverrides.js';
import type { MediaRepository } from '../mediaCommerce/repositoryContract.js';
import { evaluatePrecheckout, evaluatePaymentSuccess } from '../modules/commerce/paymentLifecycle.js';
import { resolveAbTestSelection } from '../modules/experiments/selection.js';

export { MediaCommerceOperationError } from '../mediaCommerce/operations.js';
export { buildPaymentOption } from './mediaCommerce/paymentResponses.js';

type MediaLocalizationReader = {
  getTelegramCopy(locale: string): Promise<ReturnType<typeof getMediaUxCopy>>;
  getPaymentMethods?(locale: string, channel: "telegram"): Promise<Array<"stars" | "sbp">>;
  getNamespace?(locale: string, namespace: string): Promise<Record<string, unknown>>;
};

type PaymentUiActionKind =
  | "reveal_feature_payment_options"
  | "subscription_payment_source_toggle";
type SubscriptionCatalogPlan = ReturnType<typeof resolveSubscriptionPlans>[number] & {
  subscription_change?:'upgrade';
  upgrade_base_sku?:string;
  upgrade_discount_percent?:number;
};
const FREE_CALLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function replaceCount(template: string, count: number): string {
  return template.replaceAll("{count}", String(count));
}

function buildStableCallbackToken(parts: Array<string | number | null | undefined>): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u001f"))
    .digest("hex")
    .slice(0, 32);

  return `btn_${hash}`;
}

function buildFreeActionTokenRow(input: {
  action_kind: "free_fast_scene_skip" | "free_scene_unlock" | "free_photo_unlock";
  chat_id: number;
  scene_session_id: string;
  turn_no: number | null;
  scene_turn_no: number | null;
  character_i?: number | null;
  scene_mode?: string | null;
  media_signature?: string | null;
  target_message_id?: number | null;
  current_uuid?: string | null;
  base_price_xtr?: number | null;
  photo_sku?: string | null;
  feature_key: "fast_scene_skip" | "scene_unlock" | "photo_unlock";
  action_button_text: string;
  requested_action?: string | null;
  panel_text?: string | null;
  panel_entities_json?: unknown[] | null;
  ab_test?: AbTestContext | null;
}): InteractionTokenRow {
  const normalizedPhotoSku = input.feature_key === "photo_unlock"
    ? normalizeString(input.photo_sku)
    : null;
  const token = buildStableCallbackToken([
    input.action_kind,
    input.chat_id,
    input.scene_session_id,
    input.turn_no,
    input.scene_turn_no,
    input.target_message_id,
    input.feature_key,
    normalizedPhotoSku,
  ]);

  return {
    token,
    kind: "button_callback",
    chat_id: input.chat_id,
    scene_session_id: input.scene_session_id,
    turn_no: input.turn_no,
    payload_json: {
      action_kind: input.action_kind,
      ...(input.action_kind === 'free_scene_unlock' ? {duration_days:config.SCENE_ACCESS_DAYS} : {}),
      chat_id: input.chat_id,
      scene_session_id: input.scene_session_id,
      turn_no: input.turn_no,
      scene_turn_no: input.scene_turn_no,
      character_i: input.character_i ?? null,
      scene_mode: input.scene_mode ?? null,
      media_signature: input.media_signature ?? null,
      target_message_id: input.target_message_id ?? null,
      current_uuid: input.current_uuid ?? null,
      base_price_xtr: input.base_price_xtr ?? 0,
      ...(input.feature_key === "photo_unlock"
        ? { photo_sku: normalizedPhotoSku }
        : {}),
      feature_key: input.feature_key,
      requested_action:
        input.requested_action
        ?? (input.feature_key === "fast_scene_skip"
          ? "fast_scene_skip_free"
          : input.feature_key === "scene_unlock"
            ? "scene_unlock_free"
            : "photo_request"),
      action_button_text: input.action_button_text,
      panel_text: input.panel_text ?? null,
      panel_entities_json: input.panel_entities_json ?? [],
      ab_test: input.ab_test ?? null,
    },
    status: "active",
    action_kind: input.action_kind,
    expires_at: new Date(Date.now() + FREE_CALLBACK_TTL_MS).toISOString(),
  };
}

function buildPaymentUiCopy(): PaymentUiCopy {
  return { ...getMediaUxCopy().payment_ui };
}

function getFeaturePaymentHint(featureKey: string | null | undefined): string | null {
  if (featureKey === "fast_scene_skip") {
    return getMediaUxCopy().payment_ui.fast_scene_skip_hint;
  }

  if (featureKey === "scene_unlock") {
    return getMediaUxCopy().payment_ui.scene_unlock_hint;
  }

  return null;
}

function buildPaymentSourceToggleTokenMap(
  tokenRows: InteractionTokenRow[],
): Partial<Record<PaymentSource, string>> {
  return tokenRows.reduce<Partial<Record<PaymentSource, string>>>((acc, row) => {
    const payload = parseJsonObject(row.payload_json) ?? {};
    const source = normalizePaymentSource(
      typeof payload.selected_payment_source === "string"
        ? payload.selected_payment_source
        : null,
    );
    if (source) {
      acc[source] = row.token;
    }
    return acc;
  }, {});
}

function extractLegacyPaymentOptionTokens(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return normalizeInvoiceTokens(value.map((item) =>
    item != null && typeof item === "object" && !Array.isArray(item)
      ? (item as { token?: unknown }).token
      : null,
  ));
}

function extractLegacySubscriptionInvoiceTokens(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tokens: unknown[] = [];
  for (const item of value) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) continue;
    const paymentOptions = (item as { payment_options?: unknown }).payment_options;
    if (!Array.isArray(paymentOptions)) continue;
    for (const option of paymentOptions) {
      if (option != null && typeof option === "object" && !Array.isArray(option)) {
        tokens.push((option as { token?: unknown }).token);
      }
    }
  }
  return normalizeInvoiceTokens(tokens);
}

function buildPaymentUiTokenRow(input: {
  action_kind: PaymentUiActionKind;
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  scene_turn_no: number | null;
  target_message_id?: number | null;
  feature_key?: "fast_scene_skip" | "scene_unlock" | string | null;
  invoice_tokens?: string[];
  selected_payment_source?: PaymentSource | null;
  payment_source_toggle_tokens?: Partial<Record<PaymentSource, string>> | null;
  offer_id?: string | null;
  idempotency_key?: string | null;
  source?: string | null;
}): InteractionTokenRow {
  const token = buildStableCallbackToken([
    input.action_kind,
    input.chat_id,
    input.scene_session_id,
    input.turn_no,
    input.scene_turn_no,
    input.target_message_id,
    input.feature_key,
    input.selected_payment_source,
    input.idempotency_key,
  ]);

  const payload_json = input.action_kind === "subscription_payment_source_toggle"
    ? {
        action_kind: input.action_kind,
        chat_id: input.chat_id,
        offer_id: input.offer_id ?? null,
        selected_payment_source: input.selected_payment_source ?? null,
        invoice_tokens: input.invoice_tokens ?? [],
        payment_source_toggle_tokens: input.payment_source_toggle_tokens ?? null,
        source: input.source ?? null,
      }
    : {
        action_kind: input.action_kind,
        chat_id: input.chat_id,
        scene_session_id: input.scene_session_id,
        turn_no: input.turn_no,
        scene_turn_no: input.scene_turn_no,
        target_message_id: input.target_message_id ?? null,
        feature_key: input.feature_key ?? null,
        invoice_tokens: input.invoice_tokens ?? [],
      };

  return {
    token,
    kind: "button_callback",
    chat_id: input.chat_id,
    scene_session_id: input.scene_session_id,
    turn_no: input.turn_no,
    payload_json,
    status: "active",
    action_kind: input.action_kind,
    expires_at:
      input.action_kind === "subscription_payment_source_toggle"
      || (input.action_kind === "reveal_feature_payment_options" && input.scene_session_id)
        ? null
        : new Date(Date.now() + INVOICE_TTL_MS).toISOString(),
  };
}

function buildAbTokenSuffix(selection: AbTestSelection | null): string | null {
  if (!selection) {
    return null;
  }

  return createHash("sha256")
    .update([
      selection.assignment_key,
      selection.config.version,
      selection.assignment.variant,
    ].join("\u001f"))
    .digest("hex")
    .slice(0, 12);
}

function resolveSubscriptionOfferText(
  params: SubscriptionOfferExperimentParams,
  reason: MediaSubscriptionOfferReason | null,
): string | null {
  if (reason === "daily_turn_limit") {
    return params.daily_limit_offer_text ?? params.text ?? null;
  }

  if (reason === "subscription_command") {
    return params.command_offer_text ?? params.text ?? null;
  }

  return params.text ?? null;
}

function cleanDeliveredVideoMarkup(markup: unknown, tokens: unknown, urls: string[]): Record<string, unknown> | null {
  const parsed = parseJsonObject(markup);
  if (!parsed || !Array.isArray(parsed.inline_keyboard)) return null;
  const blockedTokens = new Set(normalizeInvoiceTokens(tokens));
  const blockedUrls = new Set(urls);
  const inlineKeyboard = parsed.inline_keyboard.map(row => Array.isArray(row) ? row.filter(button => {
    const parsedButton = parseJsonObject(button);
    return !blockedTokens.has(typeof parsedButton?.callback_data === 'string' ? parsedButton.callback_data : '')
      && !blockedUrls.has(typeof parsedButton?.url === 'string' ? parsedButton.url : '');
  }) : []).filter(row => row.length > 0);
  return {...parsed,inline_keyboard:inlineKeyboard};
}

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
  if (
    eventType === "payment.success.received"
    || eventType === "payment.confirmed.received"
    || eventType === "payment.canceled.received"
    || eventType === "payment.chargebacked.received"
  ) {
    return "payment_success";
  }
  return "noop";
}

export class MediaCommerceDecisionService {
  /** Web reads the same promoted plans and account experiment overrides as Telegram.
   * No invoice is created and no Telegram transport is called here. */
  async webProductPlans(chatId: number | null): Promise<WebProductPlan[]> {
    const selection = chatId == null ? null : await resolveAbTestSelection(this.repository, chatId, 'subscription_offer');
    const params = selection?.params ?? {};
    const subscriptions = applySubscriptionPlanOverrides(resolveSubscriptionPlans(), params);
    const offer = config.MEDIA_VIDEO_ENABLED && chatId != null
      ? await this.videos.passOfferContext(chatId, null, 'web') : null;
    const scene = offer ?? (chatId!=null && config.MEDIA_ACTION_PLANS_JSON.some(p=>p.feature_key==='scene_unlock')
      ? await this.repository.loadSceneAccessStatus({chat_id:chatId,scene_session_id:null}) : null);
    const pass = offer?.available && !offer.full_active && !offer.video_pass_active
      ? resolveVideoPassPlan(offer.paid_scene_unlock_token) : null;
    const actions = config.MEDIA_ACTION_PLANS_JSON.flatMap(item => {
      if (!config.MEDIA_VIDEO_ENABLED && ['video_unlock','video_pass'].includes(item.feature_key)) return [];
      if (item.feature_key === 'scene_unlock' && (scene?.scene_access_active || scene?.subscription_active)) return [];
      if (item.feature_key === 'video_pass') {
        return pass ? [pass] : [];
      }
      const promoted = resolveActionPlanByFeatureKey(item.feature_key);
      const effective = item.feature_key === 'scene_unlock' ? applySceneUnlockOverride(promoted, params) : promoted;
      return effective ? [effective] : [];
    });
    const photos = config.MEDIA_PHOTO_PLANS_JSON.map(item => resolvePhotoPlanBySku(item.sku)!).filter(Boolean);
    const base = (p: typeof subscriptions[number] | typeof actions[number] | typeof photos[number]) => ({
      sku: p.sku, title: p.title, description: p.description, amount_xtr: p.amount_xtr,
      amount_rub: p.amount_rub ?? null, original_amount_rub: p.original_amount_rub, promo_key: p.promo_key,
      upgrade_full_amount_xtr: p.upgrade_full_amount_xtr,upgrade_full_amount_rub:p.upgrade_full_amount_rub,
    });
    return [
      ...subscriptions.map(p => ({...base(p),kind:'subscription' as const,subscription_days:p.days,subscription_tier:p.tier ?? 'base'})),
      ...photos.map(p => ({...base(p),kind:'photo' as const})),
      ...actions.map(p => ({...base(p),kind:'feature' as const,feature_key:p.feature_key,
        ...(['scene_unlock','video_pass'].includes(p.feature_key) ? {duration_days:config.SCENE_ACCESS_DAYS,scene_session_id:scene?.scene_session_id??undefined,
          grant_cycle:(p.feature_key==='video_pass' ? offer?.video_pass_payment_token : scene?.scene_access_payment_token) ?? null} : {}),
        ...(p.feature_key === 'video_pass' && pass ? {
          purchase_variant: pass.purchase_variant,
          scene_session_id: offer?.scene_session_id ?? undefined,
          discount_percent: pass.discount_percent,
          paid_scene_unlock_token: pass.paid_scene_unlock_token,
        } : {})})),
    ];
  }
  private readonly uncertainSbpCheckouts = new Map<
    string,
    { external_payment_id: string | null; checkout_url: string | null }
  >();

  readonly resolveSbpCheckout: (tokenInput: string) => Promise<string>;

  constructor(
    private readonly repository: MediaRepository,
    private readonly starsClient: StarsInvoiceClient = new TelegramStarsPaymentAdapter(),
    private readonly sbpClient: SbpPaymentClient | null = config.SBP_ENABLED
      ? new SbpPaymentAdapter()
      : null,
    private readonly videos: VideoCommerceRepository = new VideoCommerceRepository(),
    private readonly videoSigner: typeof signVideoUrl = signVideoUrl,
    private readonly localization: MediaLocalizationReader | null = null,
  ) {
    this.resolveSbpCheckout = resolveSbpCheckout.bind(null, this.repository, this.sbpClient, this.videos, this.uncertainSbpCheckouts);
  }

  async evaluate(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const language = this.localization && this.repository.loadAccountLanguage
      ? await this.repository.loadAccountLanguage(
        normalizePositiveInteger(input.chat_id ?? input.telegram_chat_id),
        normalizePositiveInteger(input.source_user_id),
      )
      : "ru";
    const uxCopy = this.localization
      ? await this.localization.getTelegramCopy(language)
      : null;
    if (!uxCopy) {
      throw new MediaCommerceOperationError(
        "Telegram localization is unavailable",
        "localization.loadTelegramCopy",
        "localization_configuration_invalid",
      );
    }
    const commerceCopy = this.localization?.getNamespace
      ? await this.localization.getNamespace(language, "commerce")
      : {};

    return runWithMediaLocalization({ language, uxCopy, commerceCopy }, async () => {
      const response = await this.evaluateLocalized(input);
      return { ...response, language, ux_copy: uxCopy };
    });
  }

  private async evaluateLocalized(
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    if (config.MEDIA_VIDEO_ENABLED && ['video_context','claim_video_delivery','finalize_video_delivery'].includes(input.interaction_mode ?? '')) {
      return this.evaluateVideoTransport(input);
    }
    const response = await this.evaluateCore(input);
    if (!response.chat_id) return response;
    if(response.operation==='prepare_offer_callback' && response.scene_session_id && response.price_required){
      const exhausted=(response.free_photos_today??0)>=(response.daily_photo_limit??config.DAILY_FREE_LIMITS_JSON.photos);
      return this.commerceRoot(response,exhausted?'daily_photos':'photo');
    }
    if(!config.MEDIA_VIDEO_ENABLED) {
      if(response.operation==='edit_photo')return this.commerceRoot(response,'photo');
      if(response.operation==='subscription_offer_ready')return this.decorateChatVideoOffer(response);
      return response;
    }
    if (['finalize_offer','finalize_photo_event'].includes(input.interaction_mode ?? '') && input.current_reply_markup != null) {
      const panel = normalizePositiveInteger(response.panel_message_id ?? input.panel_message_id ?? input.target_message_id);
      if (panel) {
        const state = parseJsonObject(await this.videos.storePanel(response.chat_id,panel,input.current_reply_markup,
          response.media_signature ?? input.media_signature ?? null,input.selected_uuid ?? input.current_uuid ?? null));
        if (state?.panel_delivered === true) {
          const context = await this.videos.context({chat_id:response.chat_id,scene_session_id:response.scene_session_id ?? null,panel_message_id:panel});
          const selected = input.selected_uuid ?? input.current_uuid;
          const delivery = context.delivery;
          const nav = delivery?.status === 'delivered' && selected
            ? await this.videoPanelTokens(response, delivery, selected === delivery.requested_photo_uuid ? 'video_panel_requested_photo' : 'photo_next', selected)
            : null;
          return {...response,...nav,target_message_id:panel,video_panel_reconcile:true,video:{available:false,consumed:true},
            current_reply_markup:context.current_reply_markup,reply_markup:context.current_reply_markup,
            video_control_tokens:context.video_control_tokens ?? context.delivery?.video_control_tokens ?? [],
            video_payment_urls:videoPaymentCleanupUrls(context.video_payment_urls ?? context.delivery?.video_payment_urls,
              context.delivery?.payment_token,context.current_reply_markup)};
        }
        if (input.interaction_mode === 'finalize_photo_event' && input.selected_uuid && response.media_signature) {
          // A first-time photo becomes a valid selector input only after its receipt.
          const photo = {...response, current_uuid:input.selected_uuid, target_message_id:panel};
          const context = await this.loadVideoContext(photo);
          const keyboard = parseJsonObject(input.current_reply_markup)?.inline_keyboard;
          const controls = new Set(context.video_control_tokens ?? []);
          const alreadyDecorated = Array.isArray(keyboard) && keyboard.flat().some(button => {
            const token = parseJsonObject(button)?.callback_data;
            return typeof token === 'string' && controls.has(token);
          });
          if (context.video && context.scene_active && !context.panel_delivered && !context.delivery && !alreadyDecorated) {
            const root:CommerceUi['return_context']={message_id:panel,kind:'photo',text:photo.caption_text??photo.panel_text,
              entities:parseJsonArray(photo.caption_entities_json??photo.panel_entities_json)??[],reply_markup:input.current_reply_markup};
            await this.allowRootButtons(root,[],photo);
            const decorated=await this.commerceRoot(photo,'photo',context,root);
            return {...decorated,video_panel_reconcile:true,reply_markup:input.current_reply_markup,
              current_reply_markup:input.current_reply_markup};
          }
        }
      }
    }
    if (response.operation === 'edit_photo' && response.media_signature) {
      return this.decoratePhotoVideo(response);
    }
    if (response.operation === 'scene_access_activated'
      || (response.operation === 'subscription_offer_ready' &&
        (response.subscription_offer_reason === 'subscription_command' || response.subscription_offer_reason === 'daily_turn_limit' ||
         response.reason === 'subscription_payment_source_toggled'))) {
      return this.decorateChatVideoOffer(response);
    }
    return response;
  }

  private async evaluateCore(input: MediaCommerceDecisionRequest): Promise<MediaCommerceDecisionResponse> {
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
        return evaluatePrecheckout(this.repository, this.videos, input);
      case "payment_success":
        return evaluatePaymentSuccess(this.repository, this.videos, this.applyMediaActionDecision.bind(this), this.loadVideoContext.bind(this), this.allowRootButtons.bind(this), this.commerceRoot.bind(this), input);
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

  private videoToken(base: MediaCommerceDecisionResponse, action: string, extra: Record<string,unknown> = {}): InteractionTokenRow {
    return buildCallbackTokenRow({chat_id:base.chat_id!,scene_session_id:base.scene_session_id ?? null,
      turn_no:base.turn_no ?? null,scene_turn_no:base.scene_turn_no ?? null,media_signature:base.media_signature ?? null,
      target_message_id:base.target_message_id ?? base.panel_message_id ?? null,current_uuid:base.current_uuid ?? base.selected_uuid ?? null,
      base_price_xtr:0,next_action:action,requested_action:action,
      extraPayload:{character_i:base.character_i ?? null,telegram_chat_id:base.telegram_chat_id ?? null,
        panel_text:base.caption_text ?? base.panel_text ?? null,panel_entities_json:base.caption_entities_json ?? base.panel_entities_json ?? [],
        ...extra,action_kind:action}});
  }

  private async loadVideoContext(base: MediaCommerceDecisionResponse): Promise<VideoContext> {
    return this.videos.context({chat_id:base.chat_id!,scene_session_id:base.scene_session_id ?? null,
      character_i:base.character_i,media_signature:base.media_signature,panel_message_id:base.target_message_id ?? base.panel_message_id,
      requested_photo_uuid:base.current_uuid ?? base.selected_uuid ?? null});
  }

  private async decoratePhotoVideo(base:MediaCommerceDecisionResponse, stored?:VideoContext) {
    const context=stored ?? await this.loadVideoContext(base);
    const exhausted=(base.free_photos_today??0)>=(base.daily_photo_limit??config.DAILY_FREE_LIMITS_JSON.photos);
    return this.commerceRoot(base,exhausted&&base.token_rows?.some(row=>row.action_kind==='free_photo_unlock')?'daily_photos':'photo',context);
  }

  private async decorateChatVideoOffer(base:MediaCommerceDecisionResponse) {
    if(base.operation==='scene_access_activated'){
      if(base.commerce_ui)return base;
      // The old text offer can be retired. The confirmation's buttons belong to a new message.
      const confirmed=await this.commerceRoot({...base,target_message_id:null,panel_message_id:null},'subscription');
      return {...confirmed,target_message_id:base.target_message_id};
    }
    return this.commerceRoot(base,base.subscription_offer_reason==='daily_turn_limit'?'daily_messages':'subscription');
  }

  private async sceneOffer(base:MediaCommerceDecisionResponse) {
    if(config.MEDIA_VIDEO_ENABLED) return this.videos.passOfferContext(base.chat_id!,base.scene_session_id ?? null,'telegram');
    const state=await this.repository.loadSceneAccessStatus({chat_id:base.chat_id!,scene_session_id:base.scene_session_id??null});
    return {scene_session_id:state?.scene_is_active?state.active_scene_session_id:null,scene_access_active:!!state?.scene_access_active,
      subscription_active:!!state?.subscription_active,available:false,full_active:false,video_pass_active:false,
      paid_scene_unlock_token:null,user_id:state?.user_id??null,matching_video:false,media_signature:null,scene_access_valid_until:null,
      video_pass_valid_until:null,video_pass_payment_token:null,scene_access_payment_token:state?.scene_access_payment_token??null};
  }

  private commerceItem(plan:NonNullable<ReturnType<typeof resolveActionPlanByFeatureKey>>,key:string,token:string,
    variant?:string,validUntil?:string|null,selectedSource?:PaymentSource|null):CommerceProduct|null {
    const prices = getPaymentPrices(plan);
    // Preserve the legacy scalar projection; renderers select from all prices.
    const preferred = getMediaLanguage()==='en' || selectedSource==='stars' ? 'stars' : 'sbp';
    const price = prices.find(item=>item.source===preferred) ?? prices[0];
    if(!price)return null;
    const labelKey=variant==='scene_unlock_upgrade'?variant:key;
    const copy=parseJsonObject(parseJsonObject(getMediaCommerceCopy().product_types)?.[labelKey]);
    const title=typeof copy?.title==='string'?copy.title:plan.title;
    const description=typeof copy?.description==='string'?copy.description:plan.description;
    const duration=key==='scene_unlock'||key==='video_pass'?config.SCENE_ACCESS_DAYS:undefined;
    return {feature_key:key,sku:plan.sku,purchase_variant:variant,duration_days:duration,valid_until:validUntil,
  label_key:labelKey,promo_key:plan.promo_key,amount:price.amount,original_amount:price.original_amount,
currency:price.currency,prices,callback_data:token,
            title:title.replaceAll('{days}',String(duration??'')),description:description.replaceAll('{days}',String(duration??''))};
  }

  private async availableSubscriptionPlans(chatId:number,sceneSessionId:string|null,params:SubscriptionOfferExperimentParams,
    knownContext?:VideoContext|null) {
    let plans:SubscriptionCatalogPlan[]=applySubscriptionPlanOverrides(resolveSubscriptionPlans(),params);
    let context:VideoContext|null=null;
    let activeSku:string|null=null;
    let nominal:typeof config.MEDIA_SUBSCRIPTION_PLANS_JSON[number]|undefined;
    if(config.MEDIA_VIDEO_ENABLED){
      context=knownContext??await this.videos.context({chat_id:chatId,scene_session_id:sceneSessionId});
      activeSku=context.subscription_sku;
      const active=activeSku&&context.subscription_until&&Date.parse(context.subscription_until)>Date.now();
      if(active)nominal=config.MEDIA_SUBSCRIPTION_PLANS_JSON.find(plan=>plan.sku===activeSku);
      if(context.full_active)plans=[];
      else if(active){
        plans=!context.video_pass_active&&nominal
          ? plans.filter(plan=>plan.tier==='full').flatMap(plan=>{
            const quote=calculateFullUpgrade(plan,nominal!,config.MEDIA_UPGRADE_DISCOUNT_PERCENT);
            if(quote.amount_xtr<=0&&(quote.amount_rub==null||quote.amount_rub<=0||!config.SBP_ENABLED))return [];
            return [{...plan,...quote,amount_rub:quote.amount_rub&&quote.amount_rub>0?quote.amount_rub:null,
              subscription_change:'upgrade' as const,upgrade_base_sku:nominal!.sku,
              upgrade_discount_percent:config.MEDIA_UPGRADE_DISCOUNT_PERCENT,
              description:renderUx(getMediaUxCopy().video?.full_upgrade_description,{description:plan.description})}];
          }) : [];
      }
    }
    return {plans,context,activeSku,nominal};
  }

  private subscriptionCommerceItem(plan:Awaited<ReturnType<MediaCommerceDecisionService['availableSubscriptionPlans']>>['plans'][number],
    selectedSource?:PaymentSource|null):CommerceProduct|null {
    const prices=getPaymentPrices(plan);
    const preferred=getMediaLanguage()==='en'||selectedSource==='stars'?'stars':'sbp';
    const price=prices.find(item=>item.source===preferred)??prices[0];
    if(!price)return null;
    const tier=plan.tier==='full'?'full':'base';
    return {feature_key:tier,sku:plan.sku,subscription_tier:tier,duration_days:plan.days,
      subscription_change:plan.subscription_change,upgrade_base_sku:plan.upgrade_base_sku,
      upgrade_discount_percent:plan.upgrade_discount_percent,promo_key:plan.promo_key,
      label_key:tier,label:plan.label,title:plan.title,description:plan.description,
      amount:price.amount,original_amount:price.original_amount,currency:price.currency,prices};
  }

  private async commerceRoot(base:MediaCommerceDecisionResponse,surface:CommerceSurface,ctx?:VideoContext|null,
    root?:CommerceUi['return_context']) {
    if(!base.chat_id)return base;
    const photo=surface==='photo'||(surface==='daily_photos'&&!!ctx?.panel_photo_uuid), panel=base.target_message_id??base.panel_message_id??null;
    const offer=await this.sceneOffer(base);
    const current=!!base.scene_session_id && offer.scene_session_id===base.scene_session_id;
    const trustedFirstPhoto=base.operation==='edit_photo' && !!base.selected_uuid && !!offer.matching_video &&
      !!base.media_signature && base.media_signature===offer.media_signature;
    const videoAvailable=!!ctx && current && ctx.scene_active && !ctx.panel_delivered &&
      (!!ctx.video || trustedFirstPhoto) && (!ctx.delivery || ctx.delivery.status==='failed');
    const canPass=current && !offer.full_active && !offer.video_pass_active && !!resolveVideoPassPlan(offer.paid_scene_unlock_token) &&
      (photo?videoAvailable&&!ctx?.delivery:offer.available);
    const abParams=(await resolveAbTestSelection(this.repository,base.chat_id,'subscription_offer'))?.params??{};
    const knownSceneEntry=base.token_rows?.some(row=>row.action_kind==='free_scene_unlock');
    const canScene=current && !offer.subscription_active && !offer.full_active && !offer.video_pass_active && !offer.scene_access_active && !!resolveActionPlanByFeatureKey('scene_unlock') &&
      (['subscription_offer_ready','prepare_offer_callback'].includes(base.operation) ? knownSceneEntry :
        abParams.scene_unlock?.enabled!==false);
    const canSubscriptions=(base.subscription_offer_items?.length??0)>0 ||
      (await this.availableSubscriptionPlans(base.chat_id,base.scene_session_id??null,abParams,ctx)).plans.length>0;
    const photoEntry=base.token_rows?.find(row=>row.action_kind==='free_photo_unlock');
    const oldEntry=base.token_rows?.find(row=>row.action_kind==='free_scene_unlock');
    const balance=photoEntry||oldEntry?await this.repository.loadFreeCredits(base.chat_id):null;
    const prior=offer.scene_access_payment_token;
    const sceneEntry=oldEntry&&prior&&(balance?.free_scene_unlocks??0)>0
      ? {...oldEntry,token:buildStableCallbackToken(['free_scene_unlock',base.chat_id,base.scene_session_id,base.turn_no,panel,prior])} : oldEntry;
    const snap={surface,opened_photo:photo,root_text:root?.text??base.caption_text??base.panel_text??base.text??null,
  root_entities:root?.entities??parseJsonArray(base.caption_entities_json??base.panel_entities_json)??[],root_receipts:base.subscription_invoice_tokens??[],photo_token:base.token_rows?.find(row=>row.action_kind==='free_photo_unlock')?.token??null,
  scene_token:sceneEntry?.token??null,
  selected_payment_source:base.selected_payment_source??null,
  payment_source_toggle_tokens:base.payment_source_toggle_tokens??null,
  user_id:offer.user_id,media_signature:base.media_signature??offer.media_signature??null,source_photo:base.current_uuid??base.selected_uuid??null};
    const rows:InteractionTokenRow[]=sceneEntry && sceneEntry!==oldEntry?[sceneEntry]:[];
    const actions:CommerceUi['actions']={};
    if(canScene||canPass||canSubscriptions){
      const row=this.videoToken(base,'commerce_scene',snap);rows.push(row);actions.scene=row.token;
    }
    if(photo && videoAvailable){
      const row=this.videoToken(base,'video_request',{...snap,video_id:ctx?.video?.video_id??null,
        requested_photo_uuid:ctx?.video?.requested_photo_uuid??snap.source_photo,source_photo_uuid:ctx?.video?.source_photo_uuid??null});
      rows.push(row);actions.video=row.token;
    }
    const products:CommerceProduct[]=[];
    for(const sub of base.subscription_offer_items??[]){
      const opts=sub.payment_options.filter(o=>o.payment_kind==='subscription' && getMediaPaymentMethods().includes(o.source));
      const opt=opts.find(o=>o.source===(base.selected_payment_source??(getMediaLanguage()==='en'?'stars':'sbp')))??opts[0];
      if(!opt||!sub.sku)continue;
      const row=this.videoToken(base,'commerce_account_pay',{...snap,sku:sub.sku,sub_tokens:opts.map(o=>o.token)});
      rows.push(row);
      const full=config.MEDIA_SUBSCRIPTION_PLANS_JSON.find(p=>p.sku===sub.sku)?.tier==='full';
      products.push({feature_key:full?'full':'base',label_key:full?'full':'base',sku:sub.sku,label:sub.title,title:sub.title,
        description:sub.description,duration_days:sub.subscription_days??undefined,
        subscription_tier:sub.subscription_tier??(full?'full':'base'),
        subscription_change:sub.subscription_change==='upgrade'?'upgrade':undefined,
        upgrade_base_sku:sub.upgrade_base_sku??undefined,
        upgrade_discount_percent:sub.upgrade_discount_percent??undefined,promo_key:sub.promo_key,
        amount:opt.amount,
original_amount:opt.original_amount,currency:opt.currency,prices:paymentOptionPrices(opts),callback_data:row.token});
    }
    if(sceneEntry && (balance?.free_scene_unlocks??0)>0)actions.bonus_scene=sceneEntry.token;
    if(photoEntry){
      const plan=resolvePhotoPlanBySku(typeof photoEntry.payload_json.photo_sku==='string'?photoEntry.payload_json.photo_sku:base.photo_sku);
      if((balance?.free_photo_unlocks??0)>0)actions.bonus_photo=photoEntry.token;
      else if(plan){
        const row=this.videoToken(base,'commerce_photo_pay',{...snap,photo_token:photoEntry.token,photo_sku:plan.sku});
        const copy=parseJsonObject(parseJsonObject(getMediaCommerceCopy().product_types)?.photo);
        const prices=getPaymentPrices(plan);
        const price=prices.find(item=>item.currency===(getMediaLanguage()==='en'?'XTR':'RUB'))??prices[0];
        if(price){
          rows.push(row);
          products.push({feature_key:'photo_unlock',sku:plan.sku,label_key:'photo',label:typeof copy?.title==='string'?copy.title:plan.title,
            title:plan.title,description:plan.description,amount:price.amount,original_amount:price.original_amount,
            currency:price.currency,prices,callback_data:row.token});
        }
      }
    }
    if(rows.length)await this.repository.upsertCallbackTokens(rows);
    const kind=surface==='subscription'||surface==='daily_messages'?'subscription':'photo';
    const ui:CommerceUi={surface,step:'root',actions,products,return_context:root??{kind,message_id:panel,
      text:snap.root_text,entities:snap.root_entities}};
    const video:VideoUi={available:videoAvailable,consumed:!!ctx?.panel_delivered,full_active:offer.full_active,video_pass_active:offer.video_pass_active,
      animate_callback_data:actions.video,chat_offer_callback_data:actions.scene};
    // Token rows also serve the existing non-UI callers. The renderer uses the separately authorized actions.
    return {...base,commerce_ui:ui,video,token_rows:sceneEntry!==oldEntry?base.token_rows?.map(row=>row===oldEntry?sceneEntry!:row):base.token_rows};
  }

  private async commerceCallback(base:MediaCommerceDecisionResponse, payload:Record<string,unknown>, action:string, input:MediaCommerceDecisionRequest) {
    const surface=(payload.surface??(payload.pass_menu?'subscription':'photo')) as CommerceSurface;
    const photo=surface==='photo'||(surface==='daily_photos'&&payload.opened_photo===true);
    const stale=()=>({...base,operation:'noop' as const,callback_valid:false,
      callback_answer_text:getMediaUxCopy().payment_errors.stale,reason:'commerce_screen_stale'});
    const raw=parseJsonObject(parseJsonObject(input.raw_update)?.callback_query);
    const message=parseJsonObject(raw?.message);
    const messageId=normalizePositiveInteger(message?.message_id??input.inbound_message_id??base.target_message_id);
    const sender=normalizePositiveInteger(parseJsonObject(raw?.from)?.id??input.source_user_id??input.telegram_chat_id);
    if(!base.chat_id||!messageId ||
      (input.chat_id!=null&&base.chat_id!==input.chat_id) ||
      (payload.target_message_id!=null&&Number(payload.target_message_id)!==messageId) ||
      (sender && payload.telegram_chat_id!=null && sender!==Number(payload.telegram_chat_id)))return stale();
    const selectedSource=normalizePaymentSource(
  typeof payload.selected_payment_source==='string'
    ? payload.selected_payment_source
    : null
);
const toggleTokens=parseJsonObject(payload.payment_source_toggle_tokens) as Partial<Record<PaymentSource,string>>|null;

base={
  ...base,
  target_message_id:messageId,
  telegram_chat_id:sender??base.telegram_chat_id,
  selected_payment_source:selectedSource??base.selected_payment_source,
  payment_source_toggle_tokens:toggleTokens??base.payment_source_toggle_tokens
};
    const account=action==='commerce_account_pay';
    const offer=await this.sceneOffer(account ? {...base,scene_session_id:null} : base);
    if(!account && base.scene_session_id && offer.scene_session_id!==base.scene_session_id || (payload.user_id!=null&&payload.user_id!==offer.user_id))return stale();
    const signature=typeof payload.media_signature==='string'?payload.media_signature:null;
    const uuid=typeof payload.source_photo==='string'?payload.source_photo:base.current_uuid??null;
    const ctx=photo&&config.MEDIA_VIDEO_ENABLED ? await this.loadVideoContext({...base,current_uuid:uuid}) : null;
    if(photo && (ctx?.panel_photo_uuid && uuid!==ctx.panel_photo_uuid || ctx?.panel_media_signature && ctx.panel_media_signature!==signature))return stale();
    if(!account && action!=='commerce_back' && !photo && signature && offer.media_signature && offer.media_signature!==signature)return stale();
    const rootText=typeof payload.root_text==='string'?payload.root_text:base.panel_text??null;
    const root:CommerceUi['return_context']={message_id:messageId,kind:surface==='subscription'||surface==='daily_messages'?'subscription':'photo',
      text:rootText,entities:Array.isArray(payload.root_entities)?payload.root_entities:[],
      reply_markup:payload.root_markup??base.current_reply_markup};
   const snap={surface,opened_photo:photo,root_text:root.text,root_entities:root.entities,root_markup:root.reply_markup,
  root_receipts:Array.isArray(payload.root_receipts)?payload.root_receipts:[],
  photo_token:payload.photo_token??null,
  scene_token:payload.scene_token??null,
  selected_payment_source:base.selected_payment_source??null,
  payment_source_toggle_tokens:base.payment_source_toggle_tokens??null,
  user_id:offer.user_id,
  media_signature:signature??offer.media_signature??null,source_photo:uuid};
    if(action==='commerce_subscriptions'){
      const prepared=await this.evaluateSubscriptionOffer({
        ...input,
        interaction_mode:'subscription_offer',
        event_type:null,
        chat_id:base.chat_id,
        telegram_chat_id:base.telegram_chat_id,
        scene_session_id:base.scene_session_id,
        scene_turn_no:base.scene_turn_no,
        target_message_id:messageId,
        panel_message_id:messageId,
        panel_text:root.text??null,
        panel_entities_json:root.entities??[],
        subscription_offer_reason:'subscription_command',
        idempotency_key:`commerce-subscriptions:${base.callback_data}`,
        source:'commerce_subscriptions',
      });
      return {...prepared,callback_valid:true,callback_answer_text:'',target_message_id:messageId,
        panel_message_id:messageId,offer_message_id:messageId,offer_reused:true,
        panel_text:root.text??null,panel_entities_json:root.entities??[],
        current_reply_markup:root.reply_markup,message_kind:base.message_kind};
    }
    const stage=action==='commerce_back'?payload.back_step:action==='commerce_account_pay'||action==='commerce_photo_pay'?'existing':action==='commerce_pay'?payload.product_step:
      action==='video_request'?'video':'scene';
    if(stage==='existing'){
      const back=this.videoToken(base,'commerce_back',{...snap,back_step:'root',photo_token:payload.photo_token??null});
      let options:MediaPaymentOption[];
      let sku=typeof payload.sku==='string'?payload.sku:'';
      let key='base';
      if(action==='commerce_account_pay'){
        if(!Array.isArray(payload.sub_tokens))return stale();
        const rows=await this.currentSubscriptionRows(payload.sub_tokens,base);
        options=rows.filter(row=>row.sku===sku).map(buildPaymentOption);
        key=config.MEDIA_SUBSCRIPTION_PLANS_JSON.find(p=>p.sku===sku)?.tier==='full'?'full':'base';
      }else{
        const saved=typeof payload.photo_token==='string'?await this.repository.loadCallbackToken(payload.photo_token,base.chat_id):null;
        if(!saved?.found||saved.status!=='active'||isExpired(saved.expires_at)||saved.scene_session_id!==base.scene_session_id||offer.scene_access_active||offer.subscription_active)return stale();
        const source=parseJsonObject(saved.payload_json)??{};
        sku=String(source.photo_sku??base.photo_sku??'');
        options=await this.buildPhotoPaymentOptionsAtClick({token:saved.token!,chat_id:base.chat_id!,scene_session_id:base.scene_session_id!,
          photo_sku:sku,media_signature:signature,target_message_id:messageId,current_uuid:uuid,requested_action:String(source.requested_action??'photo_request'),
          base_price_xtr:normalizePositiveInteger(source.base_price_xtr)??10,turn_no:normalizeNonNegativeInteger(source.turn_no),
          scene_turn_no:normalizeNonNegativeInteger(source.scene_turn_no),panel_text:root.text??null,panel_entities_json:root.entities??[]});
        key='photo_unlock';
      }
      const opt=options.find(o=>o.source===base.selected_payment_source)
  ??options.find(o=>o.currency===(getMediaLanguage()==='en'?'XTR':'RUB'))
  ??options[0];
      if(!opt)return stale();
      const product:CommerceProduct={feature_key:key,sku,label_key:key,title:opt.title,label:opt.title,description:opt.description,
        amount:opt.amount,original_amount:opt.original_amount,currency:opt.currency,prices:paymentOptionPrices(options),callback_data:String(base.callback_data)};
      await this.repository.upsertCallbackTokens([back]);
      const ui:CommerceUi={surface,step:'payment',products:[product],actions:{back:back.token},payment_options:options,return_context:root};
      return {...base,operation:'video_ui_ready' as const,commerce_ui:ui,reason:'commerce_payment'};
    }
    if(stage==='root'){
      const subs=groupOfferItems(await this.currentSubscriptionRows(snap.root_receipts,base));
      const photoRows:InteractionTokenRow[]=[];
      for(const id of [payload.photo_token,payload.scene_token]){
        if(typeof id!=='string')continue;
        const entry=await this.repository.loadCallbackToken(id,base.chat_id);
        if(entry?.found && entry.token && entry.payload_json && entry.status==='active' && !isExpired(entry.expires_at) &&
          entry.scene_session_id===base.scene_session_id)photoRows.push({...entry,kind:'button_callback',payload_json:entry.payload_json} as InteractionTokenRow);
      }
      await this.allowRootButtons(root,snap.root_receipts,base);
      const restored=await this.commerceRoot({...base,caption_text:root.text,current_uuid:uuid,subscription_offer_items:subs,token_rows:photoRows,subscription_invoice_tokens:snap.root_receipts as string[]},surface,ctx,root);
      return {...restored,operation:'video_ui_ready' as const,reason:'commerce_root'};
    }
    if(stage!=='scene'&&stage!=='video')return stale();
    const hasVideo=photo?!!ctx?.video&&ctx.scene_active&&!ctx.panel_delivered&&!ctx.delivery:offer.available;
    if(stage==='video' && (!photo || !ctx))return stale();
    if(stage==='video' && ctx && (ctx.delivery || ctx.full_active || ctx.video_pass_active)){
      return this.evaluateVideoCallback({...base,current_uuid:uuid},payload);
    }
    const abParams=(await resolveAbTestSelection(this.repository,base.chat_id!,'subscription_offer'))?.params??{};
    const scenePlan=!offer.subscription_active&&!offer.scene_access_active && stage==='scene'
      ? applySceneUnlockOverride(resolveActionPlanByFeatureKey('scene_unlock'),abParams) : null;
    const unlockPlan=stage==='video'&&hasVideo?resolveActionPlanByFeatureKey('video_unlock'):null;
    const pass=hasVideo && !offer.full_active && !offer.video_pass_active?resolveVideoPassPlan(offer.paid_scene_unlock_token):null;
    const back=this.videoToken(base,'commerce_back',{...snap,back_step:action==='commerce_pay'?stage:'root'});
    const rows=[back],products:CommerceProduct[]=[];
    for(const plan of [scenePlan,unlockPlan,pass]){
      if(!plan)continue;
      const variant=plan.feature_key==='video_pass'?pass?.purchase_variant:undefined;
      const row=this.videoToken(base,'commerce_pay',{...snap,product_step:stage,feature_key:plan.feature_key,purchase_variant:variant??null,
        quoted_xtr:plan.amount_xtr,quoted_rub:plan.amount_rub??null,video_id:ctx?.video?.video_id??null});
      const item=this.commerceItem(
  plan,
  plan.feature_key,
  row.token,
  variant,
  plan.feature_key==='video_pass'
    ? offer.video_pass_valid_until
    : offer.scene_access_valid_until,
  base.selected_payment_source
);
      if(item){rows.push(row);products.push(item);}
    }
    const actions:CommerceUi['actions']={back:back.token};
    if(stage==='scene'){
      const subscriptions=await this.availableSubscriptionPlans(base.chat_id!,base.scene_session_id??null,abParams);
      const subscriptionProducts=subscriptions.plans.flatMap(plan=>{
        const item=this.subscriptionCommerceItem(plan,base.selected_payment_source);
        return item?[item]:[];
      });
      products.push(...subscriptionProducts);
      if(subscriptionProducts.length){
        const row=this.videoToken(base,'commerce_subscriptions',snap);
        rows.push(row);actions.subscriptions=row.token;
      }
    }
    if(!products.length)return stale();
    const ui:CommerceUi={surface,step:stage,products,actions,return_context:root};
    if(action==='commerce_pay'){
      const product=products.find(item=>item.feature_key===payload.feature_key);
      const plan=product?.feature_key==='scene_unlock'?scenePlan:product?.feature_key==='video_unlock'?unlockPlan:pass;
      if(!product||!plan||product.purchase_variant!==(payload.purchase_variant??undefined) ||
         plan.amount_xtr!==payload.quoted_xtr || (plan.amount_rub??null)!==payload.quoted_rub ||
         (stage==='video'&&ctx?.video?.video_id!==payload.video_id))return stale();
      let options:MediaPaymentOption[];
      const cycle=product.feature_key==='scene_unlock'?offer.scene_access_payment_token:offer.video_pass_payment_token;
      const key=createHash('sha256').update(JSON.stringify([base.chat_id,base.scene_session_id,messageId,stage,product.feature_key,
        product.purchase_variant,cycle??null,plan.amount_xtr,plan.amount_rub,uuid,snap.media_signature])).digest('hex').slice(0,24);
      if(product.feature_key==='scene_unlock'){
        options=await this.buildSceneUnlockPaymentOptionsAtClick({chat_id:base.chat_id!,scene_session_id:base.scene_session_id!,target_message_id:messageId,token:key,
          user_id:offer.user_id,signature:snap.media_signature,commerce_origin:snap});
      }else{
        const opened=await this.evaluateVideoCallback({...base,current_uuid:uuid,media_signature:snap.media_signature},
          {...payload,chosen_feature:product.feature_key,pass_only:stage==='scene',pass_menu:!photo,video_purchase_key:key});
        if(opened.operation!=='video_ui_ready')return opened;
        options=product.feature_key==='video_pass'?opened.video?.pass_payment_options??[]:opened.video?.unlock_payment_options??[];
      }
      if(!options.length)return stale();
      ui.products=[{...product,prices:paymentOptionPrices(options)}];ui.step='payment';ui.payment_options=options;
      await this.repository.upsertCallbackTokens([back]);
    }else await this.repository.upsertCallbackTokens(rows);
    return {...base,operation:'video_ui_ready' as const,commerce_ui:ui,reason:'commerce_'+ui.step};
  }

  private async allowRootButtons(root:CommerceUi['return_context'], receipts:unknown[],base:MediaCommerceDecisionResponse) {
    const markup=parseJsonObject(root.reply_markup);
    const buttons=Array.isArray(markup?.inline_keyboard)?markup.inline_keyboard.flat().map(parseJsonObject):[];
    const allowed:string[]=[];
    for(const button of buttons){
      const token=typeof button?.callback_data==='string'?button.callback_data:null;
      if(!token)continue;
      const stored=await this.repository.loadCallbackToken(token,base.chat_id);
      if(!stored?.found || stored.status!=='active' || isExpired(stored.expires_at) || Number(stored.chat_id)!==base.chat_id ||
        (stored.scene_session_id && stored.scene_session_id!==base.scene_session_id) ||
        (stored.payload_json?.target_message_id != null && Number(stored.payload_json.target_message_id)!==root.message_id) ||
        ['video_request','video_pass_options','commerce_scene','commerce_pay','commerce_back','commerce_account_pay','commerce_photo_pay'].includes(stored.action_kind??''))continue;
      if(stored.action_kind==='free_scene_unlock' && !(Number((await this.repository.loadFreeCredits(base.chat_id!))?.free_scene_unlocks)>0))continue;
      allowed.push(token);
    }
    root.allowed_callback_data=allowed;
    root.allowed_urls=[];
    // Subscription buttons are rebuilt from their validated invoice snapshots, not copied from root markup.
  }

  private async currentSubscriptionRows(receipts:unknown[],base:MediaCommerceDecisionResponse) {
    const ids=receipts.filter((id):id is string=>typeof id==='string');
    if(!ids.length)return [];
    const active=await this.repository.loadActiveSubscriptionOfferId(base.chat_id!);
    return (await this.repository.loadStoredInvoiceTokens(ids)).filter(row=>Number(row.chat_id)===base.chat_id && row.status==='invoice_sent' &&
      !isExpired(row.expires_at) && getMediaPaymentMethods().includes(row.payment_source as PaymentSource) &&
      row.action_kind==='subscription_payment' && active && active===row.payload_json.idempotency_key)
      .map(row=>row.payment_source==='sbp'?buildSbpGatewayRow(row):row);
  }

  private async videoPanelTokens(base: MediaCommerceDecisionResponse, delivery: VideoDelivery,
    currentAction = 'video_panel_video', ordinaryUuid?: string) {
    const { chat_id: chat, requested_photo_uuid: requested, source_photo_uuid: source, photo_message_id: panel } = delivery;
    if (!chat || !requested || !source || !panel) return null;
    if (delivery.status === 'delivered' && delivery.telegram_message_id !== panel) return null;
    const scope = await this.videos.context({chat_id: chat, scene_session_id: delivery.scene_session_id ?? null, panel_message_id: panel});
    const context = await this.repository.loadMediaContext({
      chat_id: chat, scene_session_id: delivery.scene_session_id ?? null, turn_no: null, scene_turn_no: null,
      media_signature: scope.panel_media_signature ?? null, current_uuid: requested, target_message_id: panel,
      base_price_xtr: 0, action_kind: 'photo_next', requested_action: null, invoice_token: null,
      force_deliver_after_payment: false, paid_access_mode: null, callback_valid: true, panel_text: null, panel_entities_json: []
    });
    const photos = normalizeUnlockedItems(context.unlocked_items_json);
    const make = (action: string, uuid: string) => {
      const row = this.videoToken({...base, chat_id: chat, scene_session_id: delivery.scene_session_id,
        telegram_chat_id: delivery.telegram_chat_id, target_message_id: panel, current_uuid: uuid}, action, {
          delivery_id: delivery.delivery_id, requested_photo_uuid: requested, source_photo_uuid: source
        });
      const identity = action === 'photo_next' ? [action, delivery.delivery_id, uuid] : [action, delivery.delivery_id];
      row.token = 'btn_' + createHash('sha256').update(identity.join(':')).digest('hex').slice(0,32);
      if (delivery.status === 'delivered' && action !== 'photo_next') row.expires_at = null;
      return row;
    };
    const requestedRow = make('video_panel_requested_photo', requested);
    const sourceRow = requested === source ? requestedRow : make('video_panel_source_photo', source);
    const videoRow = make('video_panel_video', source);
    const rows = photos.map(photo => photo.uuid === requested ? requestedRow : make('photo_next', photo.uuid));
    // An older paid snapshot can outlive its panel's ordinary-photo event.
    if (!rows.includes(requestedRow)) rows.push(requestedRow);
    rows.splice(rows.indexOf(requestedRow) + 1, 0, ...(source === requested ? [videoRow] : [sourceRow, videoRow]));
    const index = rows.findIndex(row => row.action_kind === currentAction &&
      (currentAction !== 'photo_next' || row.payload_json.current_uuid === ordinaryUuid));
    if (index < 0) return null;
    const callbacks = {
      video_panel_requested_callback_data: requestedRow.token,
      video_panel_source_callback_data: sourceRow.token, video_panel_video_callback_data: videoRow.token
    };
    for (const row of rows) Object.assign(row.payload_json, callbacks);
    await this.repository.upsertCallbackTokens(rows);
    // Remove the original photo arrows by token type, independent of locale or label.
    const markup = parseJsonObject(delivery.current_reply_markup);
    const previous = (Array.isArray(markup?.inline_keyboard) ? markup.inline_keyboard : [])
      .flat().map(button => parseJsonObject(button)?.callback_data).filter((value): value is string => typeof value === 'string');
    const oldNav = await Promise.all(previous.map(async token => {
      const saved = await this.repository.loadCallbackToken(token, chat);
      return saved?.action_kind === 'photo_prev' || saved?.action_kind === 'photo_next' ? token : null;
    }));
    const button = (text: string, offset: number) => ({text, callback_data: rows[(index + offset + rows.length) % rows.length]!.token});
    const ordinaryPhoto = currentAction === 'photo_next' ? photos.find(photo => photo.uuid === ordinaryUuid) : null;
    return {...callbacks, ordinaryPhoto,
      panel_navigation_row: [button('‹', -1), button(String(index + 1) + '/' + rows.length, 0), button('›', 1)],
      panel_navigation_tokens: [...rows.map(row => row.token), ...oldNav.filter((token): token is string => token !== null)]};
  }

  private async evaluateVideoPanelCallback(base: MediaCommerceDecisionResponse, payload: Record<string,unknown>,
    action: string, input: MediaCommerceDecisionRequest): Promise<MediaCommerceDecisionResponse> {
    const id = typeof payload.delivery_id === 'string' ? payload.delivery_id : null;
    if (!id) return {...base, operation:'noop', reason:'video_delivery_required'};
    const delivery = await this.videos.getDelivery(id);
    const callback = parseJsonObject(parseJsonObject(input.raw_update)?.callback_query);
    const message = parseJsonObject(callback?.message);
    const sender = normalizePositiveInteger(parseJsonObject(callback?.from)?.id ?? input.source_user_id ?? input.telegram_chat_id);
    const panel = normalizePositiveInteger(message?.message_id ?? input.inbound_message_id);
    const transport = normalizePositiveInteger(parseJsonObject(message?.chat)?.id ?? input.telegram_chat_id);
    if (!delivery || delivery.source !== 'telegram' || delivery.status !== 'delivered' ||
      delivery.telegram_message_id !== delivery.photo_message_id ||
      delivery.chat_id !== base.chat_id || (input.chat_id != null && delivery.chat_id !== input.chat_id) ||
      delivery.telegram_chat_id !== sender || delivery.telegram_chat_id !== transport ||
      delivery.photo_message_id !== panel || delivery.photo_message_id !== base.target_message_id ||
      !delivery.requested_photo_uuid || !delivery.source_photo_uuid) {
      return {...base, operation:'noop', reason:'video_panel_changed'};
    }
    const nav = await this.videoPanelTokens(base, delivery, action, base.current_uuid ?? undefined);
    if (!nav) return {...base, operation:'noop', reason:'video_panel_changed'};
    const {ordinaryPhoto, ...callbacks} = nav;
    let mediaUrl: string | null;
    let uuid: string | null = null;
    if (action === 'video_panel_video') {
      mediaUrl = await this.videoSigner(delivery.bucket_name, delivery.storage_path);
    } else if (action === 'video_panel_source_photo') {
      uuid = delivery.source_photo_uuid;
      mediaUrl = sourcePhotoUrl(delivery.source_photo_bucket_name, delivery.source_photo_storage_path);
    } else if (action === 'photo_next') {
      uuid = ordinaryPhoto?.uuid ?? null;
      mediaUrl = ordinaryPhoto?.photo_url ?? null;
    } else {
      uuid = delivery.requested_photo_uuid;
      mediaUrl = (await this.repository.loadPhotoByUuid(uuid))?.photo_url ?? null;
    }
    if (!mediaUrl) return {...base, operation:'noop', reason:'video_panel_media_unavailable'};
    return {...base,...callbacks, operation:'video_panel_media_ready', delivery_id:delivery.delivery_id,
      target_message_id:panel, telegram_chat_id:transport, panel_media_kind:uuid ? 'photo' : 'video',
      panel_media_url:mediaUrl, panel_media_uuid:uuid, requested_photo_uuid:delivery.requested_photo_uuid,
      source_photo_uuid:delivery.source_photo_uuid, panel_caption:delivery.panel_caption,
      panel_caption_entities:delivery.panel_caption_entities, video_control_tokens:delivery.video_control_tokens ?? [],
      video_payment_urls:videoPaymentCleanupUrls(delivery.video_payment_urls,delivery.payment_token,delivery.current_reply_markup), reply_markup:delivery.current_reply_markup,
      current_reply_markup:delivery.current_reply_markup, reason:'video_panel_media_ready'};
  }

  private async evaluateVideoCallback(base: MediaCommerceDecisionResponse, payload: Record<string,unknown>): Promise<MediaCommerceDecisionResponse> {
    const targetMessageId = base.target_message_id ?? base.inbound_message_id ?? null;
    const frozen = {...base,target_message_id:targetMessageId,character_i:normalizePositiveInteger(payload.character_i) ?? base.character_i,
      telegram_chat_id:normalizePositiveInteger(payload.telegram_chat_id) ?? base.telegram_chat_id};
    const context = await this.loadVideoContext(frozen);
    const passOnly = payload.pass_only === true;
    if (!passOnly && context.delivery) return deliveryResponse(frozen,context.delivery);
    const menu = passOnly && payload.pass_menu === true;
    const offer = await this.videos.passOfferContext(frozen.chat_id!, frozen.scene_session_id ?? null, 'telegram');
    if (!context.scene_active || offer.scene_session_id !== frozen.scene_session_id ||
      (menu ? !offer.available : !context.video || context.panel_delivered || !!context.delivery)) {
      return {...frozen,operation:'noop',reason:'video_unavailable',callback_answer_text:renderUx(getMediaUxCopy().video?.unavailable)};
    }
    // The callback belongs to the displayed photo, never to a photo visited earlier.
    if (!menu && ((context.panel_media_signature && context.panel_media_signature !== frozen.media_signature)
      || (context.panel_photo_uuid && frozen.current_uuid && context.panel_photo_uuid !== frozen.current_uuid))) {
      return {...frozen,operation:'noop',reason:'video_panel_changed',callback_answer_text:renderUx(getMediaUxCopy().video?.panel_changed)};
    }
    if (context.full_active || context.video_pass_active) {
      if (passOnly) return {...frozen,operation:'noop',reason:'video_access_already_active'};
      if (!targetMessageId || !frozen.telegram_chat_id) return {...frozen,operation:'noop',reason:'video_panel_required'};
      return deliveryResponse(frozen,await this.videos.prepareDelivery({request_key:`video:${base.callback_data}`,
        chat_id:frozen.chat_id!,scene_session_id:frozen.scene_session_id ?? null,video_id:context.video!.video_id,
        photo_message_id:targetMessageId,telegram_chat_id:frozen.telegram_chat_id,source:'telegram',
        requested_photo_uuid:context.video!.requested_photo_uuid,panel_caption:frozen.caption_text ?? frozen.panel_text,
        panel_caption_entities:(frozen.caption_entities_json ?? frozen.panel_entities_json ?? []) as unknown[]}));
    }
    const unlock = resolveActionPlanByFeatureKey('video_unlock');
    const pass = resolveVideoPassPlan(offer.paid_scene_unlock_token);
    if (passOnly && !pass) return {...frozen,operation:'noop',reason:'video_pass_unavailable'};
    const purchaseRoot = typeof payload.video_purchase_key === 'string' ? payload.video_purchase_key
      : createHash('sha256').update([frozen.chat_id,frozen.scene_session_id,targetMessageId,context.video?.video_id ?? 'pass'].join(':')).digest('hex').slice(0,24);
    const snapshot = {chat_id:frozen.chat_id,scene_session_id:frozen.scene_session_id,character_i:context.character_i ?? frozen.character_i,
      media_signature:frozen.media_signature,video_id:passOnly ? null : context.video?.video_id,
      photo_message_id:passOnly ? null : targetMessageId,target_message_id:targetMessageId,
      telegram_chat_id:frozen.telegram_chat_id,source:'telegram',current_uuid:frozen.current_uuid,
      requested_photo_uuid:passOnly ? null : context.video?.requested_photo_uuid,
      source_photo_uuid:passOnly ? null : context.video?.source_photo_uuid,
      panel_text:frozen.caption_text ?? frozen.panel_text ?? null,
      panel_entities_json:frozen.caption_entities_json ?? frozen.panel_entities_json ?? [],
      requested_action:'video_request',base_reply_markup:base.current_reply_markup};
    const plans = [!passOnly && payload.chosen_feature!=='video_pass' ? unlock : null,payload.chosen_feature==='video_unlock'?null:pass].filter((plan): plan is NonNullable<typeof plan> => plan != null);
    const inputs = plans.flatMap(plan => {
      const variant = plan.feature_key === 'video_pass' ? pass : null;
      const suffix = variant ? (variant.purchase_variant === 'scene_unlock_upgrade' ? 'pg' : 'p') + (passOnly ? 'o' : '') : 'u';
      const rows = buildPaymentInputs({base_token:`pay_v_${purchaseRoot}_${suffix}`,
        chat_id:frozen.chat_id!,scene_session_id:frozen.scene_session_id ?? null,turn_no:frozen.turn_no ?? null,scene_turn_no:frozen.scene_turn_no ?? null,
        action_kind:'feature_payment',plan,payload_json:{...snapshot,action_kind:'feature_payment',feature_key:plan.feature_key,
          idempotency_key:`video:${purchaseRoot}:${plan.feature_key}${variant ? ':' + variant.purchase_variant + (passOnly ? ':pass_only' : ':video') : ''}`,
          original_amount_xtr:plan.original_amount_xtr,original_amount_rub:plan.original_amount_rub,promo_key:plan.promo_key,
          ...(variant ? {purchase_variant:variant.purchase_variant,paid_scene_unlock_token:variant.paid_scene_unlock_token,
            user_id:offer.user_id,pass_only:passOnly,pass_menu:menu,discount_percent:variant.discount_percent} : {})}});
      if (variant) for (const row of rows) Object.assign(row.payload_json, {
        original_amount:row.currency === 'XTR' ? variant.original_amount_xtr : variant.original_amount_rub,
        final_amount:row.amount,currency:row.currency,
      });
      return rows;
    });
    const stored = await upsertCurrentPaymentAttempts(this.repository, this.videos, inputs,'video');
    const rendered = await prepareRenderablePaymentRows(this.repository, this.starsClient, stored,'video');
    const options = rendered.map(buildPaymentOption);
    return {...frozen,operation:'video_ui_ready',video:{available:!passOnly,consumed:false,
      unlock_payment_options:options.filter(option=>option.feature_key==='video_unlock'),
      pass_payment_options:options.filter(option=>option.feature_key==='video_pass')},
      reason:'video_payment_options'};
  }

  private async evaluateVideoTransport(input: MediaCommerceDecisionRequest): Promise<MediaCommerceDecisionResponse> {
    const base = buildBaseResponse(input,'noop');
    if (input.interaction_mode === 'video_context') {
      if (!base.chat_id) return {...base,reason:'chat_id_required'};
      const panel = input.panel_message_id ?? input.target_message_id;
      if (panel && input.current_reply_markup != null) await this.videos.storePanel(base.chat_id,panel,input.current_reply_markup,input.media_signature ?? null,input.current_uuid ?? null);
      return this.decoratePhotoVideo({...base,target_message_id:panel});
    }
    if (!input.delivery_id) return {...base,reason:'delivery_id_required'};
    if (input.interaction_mode === 'claim_video_delivery') {
      const claim = randomUUID();
      const delivery = await this.videos.claimDelivery(input.delivery_id,claim);
      if (!delivery) return {...base,reason:'video_delivery_not_claimed'};
      try {
        const videoUrl = await this.videoSigner(delivery.bucket_name,delivery.storage_path);
        const callbacks=await this.videoPanelTokens(base,delivery);
        return {...base,operation:'video_delivery_claimed',delivery_id:delivery.delivery_id,claim_token:claim,
          video_url:videoUrl,target_message_id:delivery.photo_message_id,telegram_chat_id:delivery.telegram_chat_id,
          requested_photo_uuid:delivery.requested_photo_uuid,source_photo_uuid:delivery.source_photo_uuid,
          source_photo_bucket_name:delivery.source_photo_bucket_name,source_photo_storage_path:delivery.source_photo_storage_path,
          source_photo_url:sourcePhotoUrl(delivery.source_photo_bucket_name,delivery.source_photo_storage_path),
          source_photo_reveal_at:delivery.source_photo_reveal_at,same_photo:delivery.same_photo,
          panel_caption:delivery.panel_caption,panel_caption_entities:delivery.panel_caption_entities,
          ...callbacks,
          current_reply_markup:delivery.current_reply_markup,
          video_control_tokens:delivery.video_control_tokens??[],video_payment_urls:videoPaymentCleanupUrls(delivery.video_payment_urls,delivery.payment_token,delivery.current_reply_markup),
          reason:'video_delivery_claimed'};
      } catch (error) {
        await this.videos.failDelivery(input.delivery_id,claim,'video_url_signing_failed',true);
        throw error;
      }
    }
    if (!input.claim_token) return {...base,reason:'claim_token_required'};
    let delivery = input.delivery_success === true && input.sent_message_id
      ? await this.videos.completeDelivery(input.delivery_id,input.claim_token,input.sent_message_id)
      : await this.videos.failDelivery(input.delivery_id,input.claim_token,input.delivery_error ?? 'send_failed',input.retryable === true);
    const delivered = delivery?.status === 'delivered';
    const cleanupUrls=videoPaymentCleanupUrls(delivery?.video_payment_urls,delivery?.payment_token,delivery?.current_reply_markup);
    if (delivered && delivery?.chat_id && delivery.photo_message_id) {
      const cleaned=cleanDeliveredVideoMarkup(delivery.current_reply_markup,delivery.video_control_tokens,cleanupUrls);
      if (cleaned) {
        const scope=await this.videos.context({chat_id:delivery.chat_id,scene_session_id:delivery.scene_session_id ?? null,
          panel_message_id:delivery.photo_message_id});
        await this.videos.storePanel(delivery.chat_id,delivery.photo_message_id,cleaned,
          scope.panel_media_signature ?? null,scope.panel_photo_uuid ?? null);
        delivery={...delivery,current_reply_markup:cleaned};
      }
    }
    const callbacks=delivered&&delivery?await this.videoPanelTokens(base,delivery):null;
    return {...base,operation:'video_delivery_stored',delivery_id:input.delivery_id,delivered,delivery_success:delivered,
      target_message_id:delivery?.photo_message_id ?? null,telegram_chat_id:delivery?.telegram_chat_id ?? null,
      current_reply_markup:delivery?.current_reply_markup,reply_markup:delivery?.current_reply_markup,
      requested_photo_uuid:delivery?.requested_photo_uuid,source_photo_uuid:delivery?.source_photo_uuid,
      same_photo:delivery?.same_photo,
      ...callbacks,
      video_control_tokens:delivery?.video_control_tokens ?? [],video_payment_urls:cleanupUrls,
      reason:delivered ? 'video_delivered' : `video_delivery_${delivery?.status ?? 'not_updated'}`};
  }

  private async buildSceneUnlockEntryTokenRows(input: {
    chat_id: number;
    scene_session_id: string | null;
    turn_no: number | null;
    scene_turn_no: number | null;
    media_signature?: string | null;
    target_message_id?: number | null;
    current_uuid?: string | null;
    base_price_xtr?: number | null;
    subscription_active: boolean;
    scene_access_active: boolean;
    ab_selection?: AbTestSelection | null;
  }): Promise<InteractionTokenRow[]> {
    if (
      input.subscription_active
      || input.scene_access_active
      || !input.scene_session_id
    ) {
      return [];
    }

    const abSelection = input.ab_selection === undefined
      ? await resolveAbTestSelection(this.repository, input.chat_id, "subscription_offer")
      : input.ab_selection;
    if (abSelection?.params.scene_unlock?.enabled === false) {
      return [];
    }

    return [
      buildFreeActionTokenRow({
        action_kind: "free_scene_unlock",
        chat_id: input.chat_id,
        scene_session_id: input.scene_session_id,
        turn_no: input.turn_no,
        scene_turn_no: input.scene_turn_no,
        media_signature: input.media_signature,
        target_message_id: input.target_message_id,
        current_uuid: input.current_uuid,
        base_price_xtr: input.base_price_xtr,
        feature_key: "scene_unlock",
        action_button_text: renderUx(getMediaUxCopy().commerce_ui?.free_scene_unlock),
        ab_test: toAbTestContext(abSelection),
      }),
    ];
  }

  private async buildSceneUnlockPaymentOptionsAtClick(input: {
    token: string;
    chat_id: number;
    scene_session_id: string;
    target_message_id: number | null;
    user_id?:string|null;
    signature?:string|null;
    commerce_origin?:Record<string,unknown>;
  }): Promise<MediaPaymentOption[]> {
    const abSelection = await resolveAbTestSelection(this.repository, 
      input.chat_id,
      "subscription_offer",
    );
    const plan = applySceneUnlockOverride(
      resolveActionPlanByFeatureKey("scene_unlock"),
      abSelection?.params ?? {},
    );
    if (!plan) {
      return [];
    }

    const rows = await upsertCurrentPaymentAttempts(this.repository, this.videos, 
      buildSceneUnlockPaymentInputs({
        chat_id: input.chat_id,
        scene_session_id: input.scene_session_id,
        idempotency_key: `scene-unlock-click:${input.token}`,
        user_id:input.user_id,media_signature:input.signature,commerce_origin:input.commerce_origin,
        turn_limit: config.DAILY_FREE_LIMITS_JSON.messages,
        target_message_id: input.target_message_id,
        plan,
        ab_test: toAbTestContext(abSelection),
      }),
      "sceneUnlock.click",
    );
    const readyRows = await prepareRenderablePaymentRows(this.repository, this.starsClient, 
      rows,
      "sceneUnlock.click",
    );

    return buildOfferItem(readyRows)?.payment_options ?? [];
  }

  private buildPhotoUnlockEntryTokenRow(input: {
    chat_id: number;
    scene_session_id: string;
    turn_no: number | null;
    scene_turn_no: number | null;
    media_signature: string | null;
    target_message_id: number | null;
    current_uuid: string | null;
    base_price_xtr: number;
    photo_sku?: string | null;
    requested_action: string;
    panel_text?: string | null;
    panel_entities_json?: unknown[] | null;
  }): InteractionTokenRow {
    return buildFreeActionTokenRow({
      action_kind: "free_photo_unlock",
      chat_id: input.chat_id,
      scene_session_id: input.scene_session_id,
      turn_no: input.turn_no,
      scene_turn_no: input.scene_turn_no,
      media_signature: input.media_signature,
      target_message_id: input.target_message_id,
      current_uuid: input.current_uuid,
      base_price_xtr: input.base_price_xtr,
      photo_sku: input.photo_sku,
      feature_key: "photo_unlock",
      requested_action: input.requested_action,
      panel_text: input.panel_text,
      panel_entities_json: input.panel_entities_json,
      action_button_text: getMediaUxCopy().media.get_photo_button,
    });
  }

  private async buildPhotoPaymentOptionsAtClick(input: {
    token: string;
    chat_id: number;
    scene_session_id: string;
    turn_no: number | null;
    scene_turn_no: number | null;
    media_signature: string | null;
    target_message_id: number | null;
    current_uuid: string | null;
    base_price_xtr: number;
    photo_sku: string | null;
    requested_action: string;
    panel_text: string | null;
    panel_entities_json: unknown[];
  }): Promise<MediaPaymentOption[]> {
    const plan = resolvePhotoPlanBySku(input.photo_sku);
    if (!plan) {
      throw new MediaCommerceOperationError(
        `Unknown configured photo SKU: ${input.photo_sku ?? "<missing>"}`,
        "photoUnlock.resolvePlan",
        "unknown_photo_sku",
      );
    }
    const stars = buildPhotoInvoiceInput({
        token: `photo-unlock-click:${input.token}`,
        chat_id: input.chat_id,
        scene_session_id: input.scene_session_id,
        turn_no: input.turn_no,
        scene_turn_no: input.scene_turn_no,
        media_signature: input.media_signature,
        target_message_id: input.target_message_id,
        current_uuid: input.current_uuid,
        base_price_xtr: input.base_price_xtr,
        amount_xtr: plan.amount_xtr,
        original_amount_xtr: plan.original_amount_xtr,
        promo_key: plan.promo_key,
        invoice_sku: plan.sku,
        invoice_title: plan.title,
        invoice_description: plan.description,
        invoice_label: plan.label,
        invoice_button_text: plan.button_text,
        payload_json: {
          action_kind: "photo_payment",
          chat_id: input.chat_id,
          scene_session_id: input.scene_session_id,
          turn_no: input.turn_no,
          scene_turn_no: input.scene_turn_no,
          media_signature: input.media_signature,
          target_message_id: input.target_message_id,
          current_uuid: input.current_uuid,
          base_price_xtr: input.base_price_xtr,
          photo_sku: plan.sku,
          requested_action: input.requested_action,
          panel_text: input.panel_text,
          panel_entities_json: input.panel_entities_json,
          idempotency_key: `photo-unlock-click:${input.token}`,
          original_amount_xtr: plan.original_amount_xtr,
          original_amount_rub: plan.original_amount_rub,
          promo_key: plan.promo_key,
        },
    });
    const rows:StoredInvoiceToken[]=[];
    const methods=getMediaPaymentMethods();
    if(methods.includes('stars')){
      const stored=await this.repository.upsertInvoiceToken(stars);
      if(stored)rows.push(stored);
    }
    if(methods.includes('sbp') && plan.amount_rub!=null){
      const rub=buildPaymentInputs({base_token:stars.token,chat_id:input.chat_id,scene_session_id:input.scene_session_id,
        turn_no:input.turn_no,scene_turn_no:input.scene_turn_no,action_kind:'photo_payment',plan,payload_json:stars.payload_json})
        .filter(row=>row.payment_source==='sbp');
      rows.push(...await upsertCurrentPaymentAttempts(this.repository, this.videos, rub,'photoUnlock.click'));
    }
    return (await prepareRenderablePaymentRows(this.repository, this.starsClient, rows,'photoUnlock.click')).map(buildPaymentOption);
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

    return this.resolvePrepareOffer(base, stats, normalizeString(input.photo_sku));
  }

  private async resolvePrepareOffer(
    base: MediaCommerceDecisionResponse,
    stats: MediaOfferStats,
    photoSku: string | null,
  ): Promise<MediaCommerceDecisionResponse> {
    const confirmed = normalizeNonNegativeInteger(stats.free_photos_today) ?? 0;
    base = {...base, free_photos_today: confirmed, daily_photo_limit: config.DAILY_FREE_LIMITS_JSON.photos};
    const subscriptionActive = stats.subscription_active === true;
    const sceneAccessActive = stats.scene_access_active === true;
    const totalAvailable = normalizeNonNegativeInteger(stats.total_available) ?? 0;
    const unseenAvailable = normalizeNonNegativeInteger(stats.unseen_available) ?? 0;
    const existingPanel = normalizePositiveInteger(stats.existing_panel_message_id);
    const basePrice = normalizePositiveInteger(stats.base_price_xtr) ?? 10;
    const priceRequired = calculateMediaPriceRequired({
      subscription_active: subscriptionActive,
      scene_access_active: sceneAccessActive,
      free_photos_today: confirmed + (stats.pending_free_photos ?? 0),
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

    const sceneUnlockTokenRows = await this.buildSceneUnlockEntryTokenRows({
      chat_id: stats.chat_id,
      scene_session_id: stats.scene_session_id,
      turn_no: stats.turn_no,
      scene_turn_no: stats.scene_turn_no,
      media_signature: mediaSignature,
      target_message_id: null,
      current_uuid: null,
      base_price_xtr: basePrice,
      subscription_active: subscriptionActive,
      scene_access_active: sceneAccessActive,
    });

    if (priceRequired > 0) {
      if (!stats.scene_session_id) {
        return { ...base, reason: "scene_session_id_required" };
      }
      const photoUnlockTokenRow = this.buildPhotoUnlockEntryTokenRow({
        chat_id: stats.chat_id,
        scene_session_id: stats.scene_session_id,
        turn_no: stats.turn_no,
        scene_turn_no: stats.scene_turn_no,
        media_signature: mediaSignature,
        target_message_id: null,
        current_uuid: null,
        base_price_xtr: basePrice,
        photo_sku: photoSku,
        requested_action: "photo_request",
      });
      const tokenRows = [photoUnlockTokenRow, ...sceneUnlockTokenRows];
      const tokenRowsInserted = await this.repository.upsertCallbackTokens(tokenRows);

      return {
        ...base,
        chat_id: stats.chat_id,
        scene_session_id: stats.scene_session_id,
        turn_no: stats.turn_no,
        scene_turn_no: stats.scene_turn_no,
        media_signature: mediaSignature,
        base_price_xtr: basePrice,
        price_required: priceRequired,
        operation: "prepare_offer_callback",
        has_media_offer: true,
        token_rows: tokenRows,
        token_rows_prepared: tokenRows.length,
        token_rows_inserted: tokenRowsInserted,
        scene_unlock_offer_item: null,
        reason: "photo_unlock_entry_ready",
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
      button_text: getMediaUxCopy().media.get_photo_button,
      extraPayload: { photo_sku: photoSku },
    });
    const tokenRows = [tokenRow, ...sceneUnlockTokenRows];
    const insertedCount = await this.repository.upsertCallbackTokens(tokenRows);

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
      token_rows: tokenRows,
      token_rows_prepared: tokenRows.length,
      token_rows_inserted: insertedCount,
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

    const featureKey = normalizeFeatureKeyValue(
      typeof input.feature_key === "string" ? input.feature_key : null,
    );
    if (!featureKey) {
      return { ...base, reason: "feature_key_invalid" };
    }

    const actionPlan = resolveActionPlanByFeatureKey(featureKey);
    if (!actionPlan) {
      return { ...base, feature_key: featureKey, reason: "feature_key_invalid" };
    }

    const freeFastSkipButton =
      getMediaUxCopy().free_actions.fast_scene_skip_button;
    const freeCredits =
      featureKey === "fast_scene_skip"
        ? await this.repository.loadFreeCredits(chatId)
        : null;
    const sceneSessionId =
      normalizeString(input.scene_session_id)
      ?? normalizeString(freeCredits?.active_scene_session_id);
    if (featureKey === "fast_scene_skip" && sceneSessionId) {
      const freeFastSkips = normalizeNonNegativeInteger(freeCredits?.free_fast_scene_skips) ?? 0;
      if (freeFastSkips > 0) {
        const tokenRow = buildFreeActionTokenRow({
          action_kind: "free_fast_scene_skip",
          chat_id: chatId,
          scene_session_id: sceneSessionId,
          turn_no: normalizeNonNegativeInteger(input.turn_no),
          scene_turn_no: normalizeNonNegativeInteger(input.scene_turn_no),
          character_i: normalizePositiveInteger(input.character_i),
          scene_mode: normalizeString(input.scene_mode),
          media_signature: normalizeString(input.media_signature),
          target_message_id: normalizePositiveInteger(input.target_message_id),
          current_uuid: normalizeLowerString(input.current_uuid),
          base_price_xtr: normalizePositiveInteger(input.base_price_xtr),
          feature_key: "fast_scene_skip",
          action_button_text: replaceCount(freeFastSkipButton, freeFastSkips),
        });
        const insertedCount = await this.repository.upsertCallbackTokens([tokenRow]);

        return {
          ...base,
          operation: "feature_offer_required",
          chat_id: chatId,
          scene_session_id: sceneSessionId,
          feature_key: featureKey,
          token_rows: [tokenRow],
          token_rows_prepared: 1,
          token_rows_inserted: insertedCount,
          payment_options: [],
          reason: "free_fast_scene_skip_available",
        };
      }
    }

    const storedFeatureInvoices = await upsertCurrentPaymentAttempts(this.repository, this.videos, 
      buildFeaturePaymentInputs({
        chat_id: chatId,
        scene_session_id: normalizeString(input.scene_session_id),
        turn_no: normalizeNonNegativeInteger(input.turn_no),
        scene_turn_no: normalizeNonNegativeInteger(input.scene_turn_no),
        character_i: normalizePositiveInteger(input.character_i),
        scene_mode: normalizeString(input.scene_mode),
        media_signature: normalizeString(input.media_signature),
        target_message_id: normalizePositiveInteger(input.target_message_id),
        current_uuid: normalizeLowerString(input.current_uuid),
        base_price_xtr: normalizePositiveInteger(input.base_price_xtr),
        idempotency_key: [
          "feature",
          chatId,
          normalizeString(input.scene_session_id) ?? "no-scene",
          normalizeNonNegativeInteger(input.turn_no) ?? "no-turn",
          normalizeNonNegativeInteger(input.scene_turn_no) ?? "no-scene-turn",
          featureKey,
        ].join(":"),
        requested_action: `${featureKey}_purchase`,
        plan: actionPlan,
      }),
      "featureOffer",
    );
    const featureInvoices = await prepareRenderablePaymentRows(this.repository, this.starsClient, 
      storedFeatureInvoices,
      "featureOffer",
    );
    const featureInvoice = selectLegacyPrimaryRow(featureInvoices);
    const featurePaymentOptions = featureInvoices
      .map((row) => buildPaymentOption(row))
      .sort((left, right) => getSourceSortOrder(left.source) - getSourceSortOrder(right.source));
    const revealTokenRows =
      featurePaymentOptions.length > 0
        ? [
            buildPaymentUiTokenRow({
              action_kind: "reveal_feature_payment_options",
              chat_id: chatId,
              scene_session_id: normalizeString(input.scene_session_id),
              turn_no: normalizeNonNegativeInteger(input.turn_no),
              scene_turn_no: normalizeNonNegativeInteger(input.scene_turn_no),
              target_message_id: normalizePositiveInteger(input.target_message_id),
              feature_key: featureKey,
              invoice_tokens: storedFeatureInvoices.map((row) => row.token),
              idempotency_key: [
                "feature-ui",
                chatId,
                normalizeString(input.scene_session_id) ?? "no-scene",
                normalizeNonNegativeInteger(input.turn_no) ?? "no-turn",
                normalizeNonNegativeInteger(input.scene_turn_no) ?? "no-scene-turn",
                featureKey,
              ].join(":"),
            }),
          ]
        : [];
    const revealTokenRowsInserted = revealTokenRows.length > 0
      ? await this.repository.upsertCallbackTokens(revealTokenRows)
      : 0;

 return {
  ...base,
  operation: "feature_offer_required",
  chat_id: chatId,
  feature_key: featureKey,
  invoice_kind: "feature",
  invoice_sku: featureInvoice?.sku ?? actionPlan.sku,
  invoice_amount: featureInvoice?.amount_xtr ?? actionPlan.amount_xtr,
  original_invoice_amount:
    normalizePositiveInteger(featureInvoice?.payload_json.original_amount_xtr)
    ?? actionPlan.original_amount_xtr
    ?? null,
  promo_key:
    normalizeString(
      typeof featureInvoice?.payload_json.promo_key === "string"
        ? featureInvoice.payload_json.promo_key
        : null,
    )
    ?? actionPlan.promo_key
    ?? null,
  invoice_title: featureInvoice?.invoice_title ?? actionPlan.title,
  invoice_description:
    featureInvoice?.invoice_description ?? actionPlan.description,
  invoice_label: featureInvoice?.invoice_label ?? actionPlan.label,
  invoice_button_text: actionPlan.button_text,
  invoice_payload_json: featureInvoice?.payload_json ?? null,
  token_rows: revealTokenRows,
  token_rows_prepared: revealTokenRows.length,
  token_rows_inserted: revealTokenRowsInserted,
  ...buildTopLevelPaymentFields(featureInvoices),
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
    const panelText =
      rawPanel.panel_text
      ?? (typeof input.panel_text === "string" && input.panel_text.length > 0
        ? input.panel_text
        : null);
    const panelEntities =
      rawPanel.panel_entities_json ?? parseJsonArray(input.panel_entities_json);

    const callbackStatus = normalizeString(callbackRow?.status);
    const isFreeActionReplay =
      callbackStatus === "fulfilled"
      && (
        actionKind === "free_fast_scene_skip"
        || actionKind === "free_scene_unlock"
        || actionKind === "free_photo_unlock"
      );
    const valid =
      Boolean(callbackRow?.found && callbackRow?.token)
      && !isExpired(callbackRow?.expires_at)
      && (callbackStatus === "active" || isFreeActionReplay);
    const answerText = !valid
      ? getMediaUxCopy().payment_errors.stale
      : (actionKind === "photo_request" || actionKind === "photo_regen")
        ? getMediaUxCopy().media.generating
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
      photo_sku:
        normalizeString(
          typeof payload.photo_sku === "string" ? payload.photo_sku : null,
        ) ?? base.photo_sku,
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
      message_kind: rawPanel.message_kind,
      current_reply_markup: rawPanel.reply_markup,
      source:
        normalizeString(typeof payload.source === "string" ? payload.source : null)
        ?? base.source,
    } satisfies MediaCommerceDecisionResponse;

    if (!valid || !callbackBase.chat_id) {
      return {
        ...callbackBase,
        operation: "noop",
        reason: valid ? "chat_id_required" : "callback_invalid",
      };
    }

    if (config.MEDIA_VIDEO_ENABLED && (['video_panel_requested_photo','video_panel_source_photo','video_panel_video'].includes(actionKind ?? '') || (actionKind === 'photo_next' && payload.delivery_id))) {
      return this.evaluateVideoPanelCallback(callbackBase, payload, actionKind!, input);
    }
    if(['commerce_scene','commerce_back','commerce_pay','commerce_account_pay','commerce_photo_pay','commerce_subscriptions','video_request','video_pass_options'].includes(actionKind??'')){
      return this.commerceCallback(callbackBase,payload,actionKind!,input);
    }

    if (
      actionKind === "free_fast_scene_skip"
      && callbackBase.chat_id
      && callbackRow?.found
      && callbackRow.token
    ) {
      return this.evaluateFreeFastSceneSkipCallback(
        callbackBase,
        callbackRow.token,
        callbackBase.chat_id,
      );
    }

    if (
      actionKind === "free_scene_unlock"
      && callbackBase.chat_id
      && callbackRow?.found
      && callbackRow.token
    ) {
      return this.evaluateFreeSceneUnlockCallback(
        callbackBase,
        callbackRow.token,
        callbackBase.chat_id,
      );
    }

    if (
      actionKind === "free_photo_unlock"
      && callbackBase.chat_id
      && callbackRow?.found
      && callbackRow.token
    ) {
      return this.evaluateFreePhotoUnlockCallback(
        callbackBase,
        callbackRow.token,
        callbackBase.chat_id,
      );
    }

    if (
      actionKind === "reveal_feature_payment_options"
      && callbackBase.chat_id
      && callbackRow?.found
      && callbackRow.token
    ) {
      return this.evaluateRevealFeaturePaymentOptionsCallback(
        callbackBase,
        payload,
      );
    }

    if (
      actionKind === "subscription_payment_source_toggle"
      && callbackBase.chat_id
      && callbackRow?.found
      && callbackRow.token
    ) {
      return this.evaluateSubscriptionPaymentSourceToggleCallback(
        callbackBase,
        payload,
      );
    }

    const loadedContext = await this.repository.loadMediaContext({
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
    const context = {
      ...loadedContext,
      photo_sku: callbackBase.photo_sku ?? null,
    };

    return this.applyMediaActionDecision(callbackBase, context);
  }

  private async evaluateRevealFeaturePaymentOptionsCallback(
    base: MediaCommerceDecisionResponse,
    payload: Record<string, unknown>,
  ): Promise<MediaCommerceDecisionResponse> {
    if (base.callback_valid !== true) {
      return {
        ...base,
        operation: "noop",
        callback_valid: false,
        callback_answer_text: getMediaUxCopy().payment_errors.stale,
        callback_show_alert: false,
        reason: "callback_invalid",
      };
    }

    const invoiceTokens =
      normalizeInvoiceTokens(payload.invoice_tokens).length > 0
        ? normalizeInvoiceTokens(payload.invoice_tokens)
        : extractLegacyPaymentOptionTokens(payload.payment_options);
    const featureKey = normalizeString(
      typeof payload.feature_key === "string" ? payload.feature_key : null,
    );
    if (!base.chat_id || invoiceTokens.length === 0 || !featureKey) {
      return {
        ...base,
        operation: "noop",
        callback_valid: false,
        callback_answer_text: getMediaUxCopy().payment_errors.stale,
        callback_show_alert: false,
        reason: "callback_invalid",
      };
    }

    const rows = await this.repository.loadStoredInvoiceTokens(invoiceTokens);
    const byToken = new Map(rows.map((row) => [row.token, row]));
    const orderedRows = invoiceTokens.flatMap((token) => {
      const row = byToken.get(token);
      return row ? [row] : [];
    });
    const groups = new Set<string>();
    let sceneSessionId: string | null = null;
    for (const row of orderedRows) {
      const purchaseGroup = buildPurchaseGroupKey(row);
      const actionKind = normalizeString(row.action_kind);
      const isPhotoUnlockRow =
        featureKey === "photo_unlock" && actionKind === "photo_payment";
      if (
        normalizePositiveInteger(row.chat_id) !== base.chat_id
        || (!isPhotoUnlockRow && actionKind !== "feature_payment")
        || (!isPhotoUnlockRow && getInvoiceFeatureKey(row) !== featureKey)
        || !purchaseGroup
      ) {
        return {
          ...base,
          operation: "noop",
          callback_valid: false,
          callback_answer_text: getMediaUxCopy().payment_errors.stale,
          callback_show_alert: false,
          reason: "callback_invalid",
        };
      }
      groups.add(purchaseGroup);
      sceneSessionId = sceneSessionId ?? normalizeString(row.scene_session_id);
    }
    if (orderedRows.length !== invoiceTokens.length || groups.size !== 1) {
      return {
        ...base,
        operation: "noop",
        callback_valid: false,
        callback_answer_text: getMediaUxCopy().payment_errors.stale,
        callback_show_alert: false,
        reason: "callback_invalid",
      };
    }
    if (sceneSessionId) {
      const sceneStatus = await this.repository.loadSceneAccessStatus({
        chat_id: base.chat_id,
        scene_session_id: sceneSessionId,
      });
      if (
        sceneStatus?.scene_is_active !== true
        || normalizeString(sceneStatus.active_scene_session_id) !== sceneSessionId
      ) {
        return {
          ...base,
          operation: "noop",
          callback_valid: false,
          callback_answer_text: getMediaUxCopy().payment_errors.stale,
          callback_show_alert: false,
          reason: "callback_invalid",
        };
      }
    }

    const supported=['photo_unlock','scene_unlock'].includes(featureKey)
      ? orderedRows.filter(row=>getMediaPaymentMethods().includes(row.payment_source as PaymentSource) && !isExpired(row.expires_at))
      : orderedRows;
    const readyRows = await prepareRenderablePaymentRows(this.repository, this.starsClient, supported,"featurePayment.rebuild");
    if (readyRows.length === 0) {
      return {
        ...base,
        operation: "noop",
        callback_valid: false,
        callback_answer_text: getMediaUxCopy().payment_errors.stale,
        callback_show_alert: false,
        reason: "callback_invalid",
      };
    }
    const paymentOptions = readyRows
      .map((row) => buildPaymentOption(row))
      .sort((left, right) => getSourceSortOrder(left.source) - getSourceSortOrder(right.source));

    let ui:CommerceUi|undefined;
    if(featureKey==='photo_unlock'||featureKey==='scene_unlock'){
      const photo=featureKey==='photo_unlock'||!!base.media_signature;
      const surface:CommerceSurface=photo?'daily_photos':'subscription';
      const root:CommerceUi['return_context']={kind:photo?'photo':'subscription',message_id:base.target_message_id??null,
        text:base.panel_text,entities:parseJsonArray(base.panel_entities_json)??[],reply_markup:base.current_reply_markup};
      const back=this.videoToken(base,'commerce_back',{surface,back_step:photo?'root':'scene',root_text:root.text,root_entities:root.entities,
        root_markup:root.reply_markup,photo_token:featureKey==='photo_unlock'?base.payment_token??base.callback_data:null});
      await this.repository.upsertCallbackTokens([back]);
      const opt=paymentOptions.find(option=>option.currency===(getMediaLanguage()==='en'?'XTR':'RUB'))??paymentOptions[0]!;
      ui={surface,step:'payment',actions:{back:back.token},products:[{feature_key:featureKey,sku:opt.sku??'',
        label_key:featureKey,title:opt.title,label:opt.title,description:opt.description,amount:opt.amount,
original_amount:opt.original_amount,currency:opt.currency,prices:paymentOptionPrices(paymentOptions),
        duration_days:featureKey==='scene_unlock'?config.SCENE_ACCESS_DAYS:undefined,callback_data:base.callback_data??''}],
        payment_options:paymentOptions,return_context:root};
    }
    return {
      ...base,commerce_ui:ui,
      operation: "feature_payment_options_revealed",
      callback_valid: true,
      callback_answer_text: "",
      payment_options: paymentOptions,
      feature_key: featureKey,
      feature_payment_hint_text:
        getFeaturePaymentHint(featureKey),
      payment_ui: buildPaymentUiCopy(),
      reason: "feature_payment_options_revealed",
    };
  }

  private async evaluateSubscriptionPaymentSourceToggleCallback(
    base: MediaCommerceDecisionResponse,
    payload: Record<string, unknown>,
  ): Promise<MediaCommerceDecisionResponse> {
    if (base.callback_valid !== true) {
      return {
        ...base,
        operation: "noop",
        callback_valid: false,
        callback_answer_text: getMediaUxCopy().payment_errors.stale,
        callback_show_alert: false,
        reason: "callback_invalid",
      };
    }

    const selectedPaymentSource = normalizePaymentSource(
      typeof payload.selected_payment_source === "string"
        ? payload.selected_payment_source
        : null,
    );
    const callbackOfferId = normalizeString(
      typeof payload.offer_id === "string" ? payload.offer_id : null,
    );
    const invoiceTokens =
      normalizeInvoiceTokens(payload.invoice_tokens).length > 0
        ? normalizeInvoiceTokens(payload.invoice_tokens)
        : extractLegacySubscriptionInvoiceTokens(payload.subscription_offer_items);
    if (!base.chat_id || invoiceTokens.length === 0 || !selectedPaymentSource) {
      return {
        ...base,
        operation: "noop",
        callback_valid: false,
        callback_answer_text: getMediaUxCopy().payment_errors.stale,
        callback_show_alert: false,
        reason: "callback_invalid",
      };
    }
    const rows = await this.repository.loadStoredInvoiceTokens(invoiceTokens);
    const byToken = new Map(rows.map((row) => [row.token, row]));
    const orderedRows = invoiceTokens.flatMap((token) => {
      const row = byToken.get(token);
      return row ? [row] : [];
    });
    const offerIds = new Set<string>();
    for (const row of orderedRows) {
      const offerId = getInvoicePurchaseId(row);
      if (
        normalizePositiveInteger(row.chat_id) !== base.chat_id
        || normalizeString(row.action_kind) !== "subscription_payment"
        || !offerId
        || !normalizeString(row.sku)
      ) {
        return {
          ...base,
          operation: "noop",
          callback_valid: false,
          callback_answer_text: getMediaUxCopy().payment_errors.stale,
          callback_show_alert: false,
          reason: "callback_invalid",
        };
      }
      offerIds.add(offerId);
    }
    const [offerId] = Array.from(offerIds);
    const activeOfferId = await this.repository.loadActiveSubscriptionOfferId(base.chat_id);
    if (
      orderedRows.length !== invoiceTokens.length
      || offerIds.size !== 1
      || (callbackOfferId != null && callbackOfferId !== offerId)
      || activeOfferId !== offerId
    ) {
      return {
        ...base,
        operation: "noop",
        callback_valid: false,
        callback_answer_text: getMediaUxCopy().payment_errors.stale,
        callback_show_alert: false,
        reason: "callback_invalid",
      };
    }

    const readyRows = await prepareRenderablePaymentRows(this.repository, this.starsClient, 
      orderedRows,
      "subscription.rebuild",
    );
    const offerItems = groupOfferItems(readyRows);
    if (offerItems.length === 0) {
      return {
        ...base,
        operation: "noop",
        callback_valid: false,
        callback_answer_text: getMediaUxCopy().payment_errors.stale,
        callback_show_alert: false,
        reason: "callback_invalid",
      };
    }
    const hasRequestedSource = offerItems.some((item) =>
      item.payment_options.some((option) => option.source === selectedPaymentSource));
    const effectivePaymentSource: PaymentSource = hasRequestedSource
  ? selectedPaymentSource
  : getFirstAvailablePaymentSource(offerItems);
    const sceneSessionId = normalizeString(base.scene_session_id);
const sceneStatus = sceneSessionId
  ? await this.repository.loadSceneAccessStatus({
      chat_id: base.chat_id,
      scene_session_id: sceneSessionId,
    })
  : null;

const sceneEntryRows =
  sceneStatus?.scene_is_active === true &&
  sceneStatus.active_scene_session_id === sceneSessionId
    ? await this.buildSceneUnlockEntryTokenRows({
        chat_id: base.chat_id,
        scene_session_id: sceneSessionId,
        turn_no: null,
        scene_turn_no: null,
        target_message_id: null,
        subscription_active: sceneStatus.subscription_active === true,
        scene_access_active: sceneStatus.scene_access_active === true,
      })
    : [];

if (sceneEntryRows.length) {
  await this.repository.upsertCallbackTokens(sceneEntryRows);
}

    return {
      ...base,
      operation: "subscription_offer_ready",
      callback_valid: true,
      callback_answer_text: "",
      selected_payment_source: effectivePaymentSource,
subscription_offer_items: offerItems,
subscription_invoice_tokens: invoiceTokens,
 token_rows: sceneEntryRows,
token_rows_prepared: sceneEntryRows.length,
      text: base.panel_text,
      free_balance_text: null,
      offer_message_id:
        base.target_message_id
        ?? base.inbound_message_id
        ?? null,
      payment_source_toggle_tokens:
        parseJsonObject(payload.payment_source_toggle_tokens) as
          | Partial<Record<PaymentSource, string>>
          | null,
      payment_ui: buildPaymentUiCopy(),
      reason: "subscription_payment_source_toggled",
    };
  }

  private async evaluateFreeFastSceneSkipCallback(
    base: MediaCommerceDecisionResponse,
    token: string,
    chatId: number,
  ): Promise<MediaCommerceDecisionResponse> {
    const redeemed = await runRepositoryOperation(
      "callback.freeFastSceneSkip.redeem",
      {
        chat_id: chatId,
        payment_kind: "feature",
        sku: null,
        invoice_status: null,
      },
      () => this.repository.redeemFreeFastSceneSkip(token, chatId),
    );
    const payload = parseJsonObject(redeemed?.payload_json) ?? {};

    if (redeemed?.redeemed === true || redeemed?.already_consumed === true) {
      return {
        ...base,
        operation: "feature_fulfillment_required",
        callback_valid: true,
        callback_answer_text: "",
        chat_id:
          normalizePositiveInteger(redeemed.chat_id)
          ?? normalizePositiveInteger(payload.chat_id)
          ?? chatId,
        scene_session_id:
          normalizeString(redeemed.scene_session_id)
          ?? normalizeString(
            typeof payload.scene_session_id === "string"
              ? payload.scene_session_id
              : null,
          ),
        turn_no:
          normalizeNonNegativeInteger(payload.turn_no)
          ?? normalizeNonNegativeInteger(redeemed.turn_no),
        scene_turn_no: normalizeNonNegativeInteger(payload.scene_turn_no),
        character_i: normalizePositiveInteger(payload.character_i),
        scene_mode: normalizeString(
          typeof payload.scene_mode === "string" ? payload.scene_mode : null,
        ),
        media_signature: normalizeString(
          typeof payload.media_signature === "string"
            ? payload.media_signature
            : null,
        ),
        target_message_id:
          normalizePositiveInteger(payload.target_message_id)
          ?? base.target_message_id
          ?? null,
        payment_kind: "feature",
        payment_token: token,
        feature_key: "fast_scene_skip",
        reason: redeemed.already_consumed
          ? "free_fast_scene_skip_already_consumed"
          : "free_fast_scene_skip_redeemed",
      };
    }

    return {
      ...base,
      operation: "noop",
      callback_valid: false,
      callback_answer_text: getMediaUxCopy().payment_errors.stale,
      callback_show_alert: false,
      payment_kind: "feature",
      payment_token: token,
      feature_key: "fast_scene_skip",
      reason: redeemed?.reason ?? "free_fast_scene_skip_invalid",
    };
  }

  private async evaluateFreeSceneUnlockCallback(
    base: MediaCommerceDecisionResponse,
    token: string,
    chatId: number,
  ): Promise<MediaCommerceDecisionResponse> {
    const redeemed = await runRepositoryOperation(
      "callback.freeSceneUnlock.redeem",
      {
        chat_id: chatId,
        payment_kind: "feature",
        sku: null,
        invoice_status: null,
      },
      () => this.repository.redeemFreeSceneUnlock(token, chatId),
    );
    const payload = parseJsonObject(redeemed?.payload_json) ?? {};

    if (redeemed?.redeemed === true || redeemed?.already_fulfilled === true) {
      return {
        ...base,
        operation: "scene_access_activated",
        text: getMediaUxCopy().callbacks.scene_access_activated,
        callback_valid: true,
        callback_answer_text: "",
        chat_id:
          normalizePositiveInteger(redeemed.chat_id)
          ?? normalizePositiveInteger(payload.chat_id)
          ?? chatId,
        scene_session_id:
          normalizeString(redeemed.scene_session_id)
          ?? normalizeString(
            typeof payload.scene_session_id === "string"
              ? payload.scene_session_id
              : null,
          ),
        turn_no:
          normalizeNonNegativeInteger(payload.turn_no)
          ?? normalizeNonNegativeInteger(redeemed.turn_no),
        scene_turn_no: normalizeNonNegativeInteger(payload.scene_turn_no),
        target_message_id:
          normalizePositiveInteger(payload.target_message_id)
          ?? base.target_message_id
          ?? null,
        payment_kind: "feature",
        payment_token: token,
        feature_key: "scene_unlock",
        stored_count: redeemed.redeemed ? 1 : 0,
        reason: redeemed.already_fulfilled
          ? "already_active"
          : "free_scene_unlock_redeemed",
      };
    }

    if (redeemed?.reason === "free_credit_unavailable") {
      const resolvedChatId =
        normalizePositiveInteger(redeemed.chat_id)
        ?? normalizePositiveInteger(payload.chat_id)
        ?? chatId;
      const resolvedSceneSessionId =
        normalizeString(redeemed.scene_session_id)
        ?? normalizeString(
          typeof payload.scene_session_id === "string"
            ? payload.scene_session_id
            : null,
        );
      const resolvedTargetMessageId =
        normalizePositiveInteger(payload.target_message_id)
        ?? base.target_message_id
        ?? null;
      if (!resolvedSceneSessionId) {
        return {
          ...base,
          operation: "noop",
          callback_valid: false,
          callback_answer_text: getMediaUxCopy().payment_errors.stale,
          callback_show_alert: false,
          reason: "scene_session_id_required",
        };
      }
      const paymentOptions = await this.buildSceneUnlockPaymentOptionsAtClick({
        token,
        chat_id: resolvedChatId,
        scene_session_id: resolvedSceneSessionId,
        target_message_id: resolvedTargetMessageId,
      });
      if (paymentOptions.length === 0) {
        return {
          ...base,
          operation: "noop",
          callback_valid: false,
          callback_answer_text: getMediaUxCopy().payment_errors.stale,
          callback_show_alert: false,
          reason: "scene_unlock_plan_missing",
        };
      }

      return this.evaluateRevealFeaturePaymentOptionsCallback(
        {
          ...base,
          callback_valid: true,
          callback_answer_text: "",
          chat_id: resolvedChatId,
          scene_session_id: resolvedSceneSessionId,
          target_message_id: resolvedTargetMessageId,
        },
        {
          ...payload,
          invoice_tokens: paymentOptions.map((option) => option.token),
        },
      );
    }

    return {
      ...base,
      operation: "noop",
      callback_valid: false,
      callback_answer_text: getMediaUxCopy().payment_errors.stale,
      callback_show_alert: false,
      payment_kind: "feature",
      payment_token: token,
      feature_key: "scene_unlock",
      reason: redeemed?.reason ?? "free_scene_unlock_invalid",
    };
  }

  private async evaluateFreePhotoUnlockCallback(
    base: MediaCommerceDecisionResponse,
    token: string,
    chatId: number,
  ): Promise<MediaCommerceDecisionResponse> {
    const redeemed = await runRepositoryOperation(
      "callback.freePhotoUnlock.redeem",
      {
        chat_id: chatId,
        payment_kind: "photo",
        sku: null,
        invoice_status: null,
      },
      () => this.repository.redeemFreePhotoUnlock(token, chatId),
    );
    const payload = parseJsonObject(redeemed?.payload_json) ?? {};
    const sceneSessionId =
      normalizeString(redeemed?.scene_session_id)
      ?? normalizeString(
        typeof payload.scene_session_id === "string"
          ? payload.scene_session_id
          : null,
      );
    const requestedAction = normalizeString(
      typeof payload.requested_action === "string"
        ? payload.requested_action
        : null,
    ) ?? "photo_request";

    const usedFreeCredit =
      redeemed?.redeemed === true || redeemed?.reason === "already_consumed";
    if (redeemed?.reason === "already_fulfilled") {
      return {
        ...base,
        operation: "noop",
        callback_valid: true,
        callback_answer_text: "",
        payment_kind: "photo",
        payment_token: token,
        feature_key: "photo_unlock",
        reason: "already_fulfilled",
      };
    }
    if (
      (usedFreeCredit || redeemed?.reason === "free_credit_not_required")
      && sceneSessionId
    ) {
      const boundPhotoUuid = usedFreeCredit
        ? normalizeLowerString(
            typeof payload.free_photo_uuid === "string"
              ? payload.free_photo_uuid
              : null,
          )
        : null;
      if (usedFreeCredit && !boundPhotoUuid) {
        return { ...base, operation: "noop", reason: "free_photo_uuid_missing" };
      }
      const loadedContext = await this.repository.loadMediaContext({
        chat_id: chatId,
        scene_session_id: sceneSessionId,
        turn_no:
          normalizeNonNegativeInteger(payload.turn_no)
          ?? normalizeNonNegativeInteger(redeemed.turn_no),
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
          normalizePositiveInteger(payload.target_message_id)
          ?? base.target_message_id
          ?? null,
        base_price_xtr: normalizePositiveInteger(payload.base_price_xtr) ?? 10,
        action_kind: requestedAction,
        requested_action: requestedAction,
        invoice_token: token,
        force_deliver_after_payment: usedFreeCredit,
        paid_access_mode: usedFreeCredit ? "free_credit" : null,
        callback_valid: true,
        panel_text: normalizeString(
          typeof payload.panel_text === "string" ? payload.panel_text : base.panel_text,
        ),
        panel_entities_json:
          parseJsonArray(payload.panel_entities_json)
          ?? base.panel_entities_json
          ?? [],
      });
      const context = {
        ...loadedContext,
        photo_sku: normalizeString(
          typeof payload.photo_sku === "string" ? payload.photo_sku : null,
        ),
      };
      if (boundPhotoUuid) {
        const boundPhoto = await this.repository.loadPhotoByUuid(boundPhotoUuid);
        if (!boundPhoto?.photo_url) {
          return {
            ...base,
            operation: "noop",
            callback_valid: false,
            reason: "free_photo_not_found",
          };
        }
        context.next_unseen_json = boundPhoto;
      }

      const response = await this.applyMediaActionDecision(
        {
          ...base,
          callback_valid: true,
          callback_answer_text: "",
          payment_kind: "photo",
          payment_token: token,
        },
        context,
      );
      return usedFreeCredit
        ? {
            ...response,
            action_kind: "free_photo_unlock",
            fulfillment_invoice_token: token,
          }
        : response;
    }

    if (redeemed?.reason === "free_credit_unavailable" && sceneSessionId) {
      const paymentOptions = await this.buildPhotoPaymentOptionsAtClick({
        token,
        chat_id: chatId,
        scene_session_id: sceneSessionId,
        turn_no:
          normalizeNonNegativeInteger(payload.turn_no)
          ?? normalizeNonNegativeInteger(redeemed.turn_no),
        scene_turn_no: normalizeNonNegativeInteger(payload.scene_turn_no),
        media_signature: normalizeString(
          typeof payload.media_signature === "string"
            ? payload.media_signature
            : null,
        ),
        target_message_id:
          normalizePositiveInteger(payload.target_message_id)
          ?? base.target_message_id
          ?? null,
        current_uuid: normalizeLowerString(
          typeof payload.current_uuid === "string" ? payload.current_uuid : null,
        ),
        base_price_xtr: normalizePositiveInteger(payload.base_price_xtr) ?? 10,
        photo_sku: normalizeString(
          typeof payload.photo_sku === "string" ? payload.photo_sku : null,
        ),
        requested_action: requestedAction,
        panel_text: normalizeString(
          typeof payload.panel_text === "string" ? payload.panel_text : base.panel_text,
        ),
        panel_entities_json:
          parseJsonArray(payload.panel_entities_json)
          ?? base.panel_entities_json
          ?? [],
      });

      return this.evaluateRevealFeaturePaymentOptionsCallback(
        {
          ...base,
          callback_valid: true,
          callback_answer_text: "",
          payment_kind: "photo",
          payment_token: token,
          scene_session_id: sceneSessionId,
        },
        {
          ...payload,
          feature_key: "photo_unlock",
          invoice_tokens: paymentOptions.map((option) => option.token),
        },
      );
    }

    return {
      ...base,
      operation: "noop",
      callback_valid: false,
      callback_answer_text: getMediaUxCopy().payment_errors.stale,
      callback_show_alert: false,
      payment_kind: "photo",
      payment_token: token,
      feature_key: "photo_unlock",
      reason: redeemed?.reason ?? "free_photo_unlock_invalid",
    };
  }

  private async applyMediaActionDecision(
    base: MediaCommerceDecisionResponse,
    context: MediaContext,
  ): Promise<MediaCommerceDecisionResponse> {
    // Reserve before returning the photo URL to Telegram. Its confirmed edit
    // closes the reservation in the same transaction as the ordinary receipt.
    const candidate = normalizeNextUnseen(context.next_unseen_json);
    if (candidate && context.callback_valid && !context.force_deliver_after_payment && !context.paid_access_mode
        && !context.subscription_active && !context.scene_access_active
        && (context.free_photos_today ?? 0) < config.DAILY_FREE_LIMITS_JSON.photos
        && (context.panel_unlocked_count ?? 0) < 5 && context.chat_id && context.scene_session_id && context.target_message_id
        && ['photo_request','photo_regen'].includes(context.action_kind ?? '') && base.callback_data) {
      const {mode,dispatchBy} = await this.repository.authorizeDailyPhoto(context.chat_id,context.scene_session_id,base.callback_data,candidate.uuid,context.target_message_id);
      if (mode === 'free') base={...base,photo_dispatch_by:dispatchBy};
      if (mode === 'nav') return {...base,operation:'noop',reason:'photo_already_unlocked'};
      const quota = config.DAILY_FREE_LIMITS_JSON.photos;
      const used = (context.free_photos_today ?? 0) + (context.pending_free_photos ?? 0);
      context = {...context, subscription_active:mode === 'subscription', scene_access_active:mode === 'scene_pass',
        free_photos_today:mode === null ? quota : Math.min(used,quota-1),pending_free_photos:0};
    }
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

    let tokenRowsInserted = 0;
    const shouldOfferPhotoUnlock =
      decision.invoice_kind === "photo"
      && Boolean(base.chat_id)
      && Boolean(context.scene_session_id);
    const requestedPhotoAction = normalizeString(
      decision.invoice_payload_json?.requested_action,
    ) ?? "photo_regen";
    const photoUnlockTokenRows = shouldOfferPhotoUnlock
      ? [
          this.buildPhotoUnlockEntryTokenRow({
            chat_id: base.chat_id as number,
            scene_session_id: context.scene_session_id as string,
            turn_no: context.turn_no,
            scene_turn_no: context.scene_turn_no,
            media_signature: context.media_signature,
            target_message_id: context.target_message_id,
            current_uuid: decision.current_uuid,
            base_price_xtr: normalizePositiveInteger(context.base_price_xtr) ?? 10,
            photo_sku: normalizeString(context.photo_sku),
            requested_action: requestedPhotoAction,
            panel_text: decision.caption_text,
            panel_entities_json: decision.caption_entities_json,
          }),
        ]
      : [];
    const sceneUnlockTokenRows = base.chat_id
      ? await this.buildSceneUnlockEntryTokenRows({
        chat_id: base.chat_id as number,
        scene_session_id: context.scene_session_id,
        turn_no: context.turn_no,
        scene_turn_no: context.scene_turn_no,
        media_signature: context.media_signature,
        target_message_id: context.target_message_id,
        current_uuid: decision.current_uuid,
        base_price_xtr: normalizePositiveInteger(context.base_price_xtr) ?? 10,
        subscription_active: context.subscription_active === true,
        scene_access_active: context.scene_access_active === true,
      })
      : [];

    const allTokenRows = [
      ...decision.token_rows,
      ...photoUnlockTokenRows,
      ...sceneUnlockTokenRows,
    ];
    tokenRowsInserted = allTokenRows.length > 0
      ? await this.repository.upsertCallbackTokens(allTokenRows)
      : 0;

    return {
      ...base,
      operation: decision.operation,
      chat_id: context.chat_id,
      scene_session_id: context.scene_session_id,
      turn_no: context.turn_no,
      scene_turn_no: context.scene_turn_no,
      media_signature: context.media_signature,
      photo_sku: normalizeString(context.photo_sku),
      target_message_id: context.target_message_id,
      current_uuid: decision.current_uuid,
      photo_url: decision.photo_url,
      selected_uuid: decision.selected_uuid,
      token_rows: allTokenRows,
      token_rows_prepared: allTokenRows.length,
      token_rows_inserted: tokenRowsInserted,
      log_event_type: decision.log_event_type,
      access_mode: decision.access_mode,
      log_price_xtr: decision.log_price_xtr,
      price_required: decision.price_required,
      invoice_kind: decision.invoice_kind,
      invoice_sku: decision.invoice_sku,
      invoice_amount: decision.invoice_amount,
      original_invoice_amount: decision.original_invoice_amount,
      promo_key: decision.promo_key,
      invoice_title: decision.invoice_title,
      invoice_description: decision.invoice_description,
      invoice_label: decision.invoice_label,
      invoice_payload_json: decision.invoice_payload_json,
      invoice_button_text: decision.invoice_button_text,
      ...buildTopLevelPaymentFields([]),
      scene_unlock_offer_item: null,
      fulfillment_invoice_token: decision.fulfillment_invoice_token,
      caption_text: decision.caption_text,
      caption_entities_json: decision.caption_entities_json,
      subscription_active: context.subscription_active,
      subscription_sku: context.subscription_sku,
      subscription_until: context.subscription_until,
      scene_access_active: context.scene_access_active,
      reason: "media_ready",
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
    const offerId = normalizeString(input.idempotency_key);
    if (!offerId) {
      return { ...base, chat_id: chatId, reason: "subscription_offer_id_required" };
    }
    const turnLimit = config.DAILY_FREE_LIMITS_JSON.messages;
    const turnsToday =
      normalizeNonNegativeInteger(input.turns_today) ?? turnLimit;
    const turnLimitResetText =
      config.TURN_LIMIT_RESET_TEXT;
    const abSelection = await resolveAbTestSelection(this.repository, 
      chatId,
      "subscription_offer",
    );
    const abContext = toAbTestContext(abSelection);
    const abParams = abSelection?.params ?? {};
    const abTokenSuffix = buildAbTokenSuffix(abSelection);
    const effectiveIdempotencyKey =
      abTokenSuffix != null
        ? `${offerId}:ab_${abTokenSuffix}`
        : offerId;
    let offerText = resolveSubscriptionOfferText(
      abParams,
      subscriptionOfferReason,
    );
    if (offerText == null) {
      const subscriptionCopy = getMediaUxCopy().subscription;
      offerText = subscriptionOfferReason === "daily_turn_limit"
        ? subscriptionCopy.daily_limit_offer
        : subscriptionOfferReason === "subscription_command"
          ? subscriptionCopy.command_offer
          : null;
    }
    const freeBalanceText = formatFreeBalances(input, getMediaUxCopy().free_balances);
    const offerAccessStatus = await runRepositoryOperation(
      "subscription.loadSceneAccessStatus",
      {
        chat_id: chatId,
        payment_kind: null,
        sku: null,
        invoice_status: null,
      },
      () => this.repository.loadSceneAccessStatus({
        chat_id: chatId,
        scene_session_id: null,
      }),
    );
    const subscriptionActive = offerAccessStatus?.subscription_active === true;
    const requestSceneSessionId = normalizeString(input.scene_session_id);
    const requestSceneTurnNo = normalizeNonNegativeInteger(input.scene_turn_no);
    const inActiveScene =
      Boolean(requestSceneSessionId)
      && offerAccessStatus?.scene_is_active === true
      && normalizeString(offerAccessStatus.active_scene_session_id) === requestSceneSessionId;
    const activeSceneSessionId =
      inActiveScene ? requestSceneSessionId : null;
    const canOfferSceneUnlock =
      !subscriptionActive
      && inActiveScene
      && activeSceneSessionId
      && abParams.scene_unlock?.enabled !== false;
    const availableSubscriptions=await this.availableSubscriptionPlans(chatId,requestSceneSessionId,abParams);
    const subscriptionPlans=availableSubscriptions.plans;
    const videoSubscriptionContext=availableSubscriptions.context;
    if(videoSubscriptionContext&&availableSubscriptions.activeSku&&videoSubscriptionContext.subscription_until&&
      Date.parse(videoSubscriptionContext.subscription_until)>Date.now()){
        const nominal=availableSubscriptions.nominal;
        const title = nominal?.title ?? availableSubscriptions.activeSku;
        offerText = [
          title,
          nominal?.description ?? '',
          renderUx(getMediaUxCopy().video?.subscription_valid_until, { date: videoSubscriptionContext.subscription_until ?? "" }),
          renderUx(getMediaUxCopy().video?.subscription_benefits_preserved),
        ].filter(Boolean).join('\n');
        if (videoSubscriptionContext.full_active) {
          offerText += '\n' + renderUx(getMediaUxCopy().video?.full_benefits);
        } else {
          offerText += '\n' + renderUx(getMediaUxCopy().video?.base_benefits);
        }
    }
    const invoiceInputs = subscriptionPlans.flatMap((plan, index) =>
      buildSubscriptionPaymentInputs({
        chat_id: chatId,
        idempotency_key: offerId,
        subscription_offer_reason: subscriptionOfferReason,
        turn_limit: turnLimit,
        turns_today: turnsToday,
        turn_limit_reset_text: turnLimitResetText,
        sort_order: index + 1,
        plan,
        ab_test: abContext,
      }));

    const upsertedRows = await upsertCurrentPaymentAttempts(this.repository, this.videos, 
      invoiceInputs,
      "subscription",
    );
    if (invoiceInputs.length > 0 && upsertedRows.length === 0) {
      return {
        ...base,
        chat_id: chatId,
        scene_session_id: activeSceneSessionId,
        reason: "subscription_payment_attempts_missing",
      };
    }
    const tokenList = upsertedRows.map((row) => row.token);
    const rows = await prepareRenderablePaymentRows(this.repository, this.starsClient, 
      upsertedRows,
      "subscription",
    );

    const sortedRows = rows
      .slice()
      .sort(
        (left, right) =>
          (normalizeNonNegativeInteger(left.payload_json.sort_order) ?? 100)
          - (normalizeNonNegativeInteger(right.payload_json.sort_order) ?? 100)
          || (normalizePositiveInteger(left.payload_json.subscription_days) ?? 0)
          - (normalizePositiveInteger(right.payload_json.subscription_days) ?? 0)
          || getSourceSortOrder(normalizePaymentSource(left.payment_source))
          - getSourceSortOrder(normalizePaymentSource(right.payment_source)),
      );
    const subscriptionOfferItems = groupOfferItems(sortedRows);
    const hasUsableSubscriptionOption = subscriptionOfferItems.some(
      (item) => item.payment_options.length > 0,
    );
    if (invoiceInputs.length > 0 && !hasUsableSubscriptionOption) {
      return {
        ...base,
        chat_id: chatId,
        scene_session_id: activeSceneSessionId,
        reason: "subscription_payment_options_missing",
      };
    }
    const sceneUnlockEntryTokenRows =
      canOfferSceneUnlock && activeSceneSessionId
        ? await this.buildSceneUnlockEntryTokenRows({
          chat_id: chatId,
          scene_session_id: activeSceneSessionId,
          turn_no: null,
          scene_turn_no: requestSceneTurnNo,
          target_message_id: null,
          subscription_active: subscriptionActive,
          scene_access_active: offerAccessStatus?.scene_access_active === true,
          ab_selection: abSelection,
        })
        : [];
    const hasSbpSubscriptionOption = subscriptionOfferItems.some((item) =>
      item.payment_kind === "subscription"
      && item.payment_options.some((option) => option.source === "sbp"));
    const hasStarsSubscriptionOption = subscriptionOfferItems.some((item) =>
      item.payment_kind === "subscription"
      && item.payment_options.some((option) => option.source === "stars"));
    const defaultPaymentSource = getFirstAvailablePaymentSource(subscriptionOfferItems);
    const offerMessageId =
      sortedRows
        .map((row) => normalizePositiveInteger(row.telegram_invoice_message_id))
        .find((value) => value != null)
      ?? null;
    const subscriptionPaymentToggleTokenRows =
      hasSbpSubscriptionOption && hasStarsSubscriptionOption
        ? (["stars", "sbp"] as const).map((source) =>
            buildPaymentUiTokenRow({
              action_kind: "subscription_payment_source_toggle",
              chat_id: chatId,
              scene_session_id: activeSceneSessionId,
              turn_no: null,
              scene_turn_no: null,
              target_message_id: offerMessageId,
              invoice_tokens: tokenList,
              offer_id: offerId,
              selected_payment_source: source,
              idempotency_key: `subscription-source-ui:${effectiveIdempotencyKey}`,
              source: input.source,
            }))
        : [];
    const paymentSourceToggleTokens = buildPaymentSourceToggleTokenMap(
      subscriptionPaymentToggleTokenRows,
    );
    const tokenRows = [
      ...sceneUnlockEntryTokenRows,
      ...subscriptionPaymentToggleTokenRows.map((row) => ({
        ...row,
        payload_json: {
          ...row.payload_json,
          payment_source_toggle_tokens: paymentSourceToggleTokens,
        },
      })),
    ];
    const tokenRowsInserted = tokenRows.length > 0
      ? await this.repository.upsertCallbackTokens(tokenRows)
      : 0;

    return {
      ...base,
      operation: "subscription_offer_ready",
      chat_id: chatId,
      scene_session_id: activeSceneSessionId,
      offer_message_id: offerMessageId,
      offer_sent: false,
      offer_reused: offerMessageId != null,
      subscription_offer_reason: subscriptionOfferReason,
      turn_limit: turnLimit,
      turns_today: turnsToday,
      turn_limit_reset_text: turnLimitResetText,
      token_rows: tokenRows,
      token_rows_prepared: tokenRows.length,
      token_rows_inserted: tokenRowsInserted,
      text: offerText,
      subscription_tier:videoSubscriptionContext?.full_active ? 'full' : 'base',
      subscription_sku:videoSubscriptionContext?.subscription_sku,
      subscription_until:videoSubscriptionContext?.subscription_until,
      free_balance_text: freeBalanceText,
      ab_test: abContext,
      subscription_offer_items: subscriptionOfferItems,
      selected_payment_source: defaultPaymentSource,
      payment_source_toggle_tokens: paymentSourceToggleTokens,
      payment_ui: buildPaymentUiCopy(),
      subscription_invoice_tokens: tokenList,
      reason:
        offerMessageId != null
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

    const actionKind = normalizeString(input.action_kind);
    const accessMode = normalizeString(input.access_mode);
    const sceneSessionId = normalizeString(input.scene_session_id);
    const turnNo = normalizeNonNegativeInteger(input.turn_no);
    const sceneTurnNo = normalizeNonNegativeInteger(input.scene_turn_no);
    const mediaSignature = normalizeString(input.media_signature);
    const uuid = normalizeLowerString(input.selected_uuid);
    const panelMessageId =
      normalizePositiveInteger(input.panel_message_id)
      ?? normalizePositiveInteger(input.target_message_id);
    const fulfillmentToken = normalizeString(input.fulfillment_invoice_token);
    const isFreePhotoCredit =
      actionKind === "free_photo_unlock" && accessMode === "free_credit";
    const result = isFreePhotoCredit
      && sceneSessionId
      && turnNo != null
      && mediaSignature
      && uuid
      && panelMessageId
      && fulfillmentToken
      ? await this.repository.finalizeFreePhotoUnlock({
          token: fulfillmentToken,
          chat_id: chatId,
          scene_session_id: sceneSessionId,
          turn_no: turnNo,
          scene_turn_no: sceneTurnNo,
          media_signature: mediaSignature,
          uuid,
          panel_message_id: panelMessageId,
        })
      : await this.repository.storePhotoEvent({
      chat_id: chatId,
      scene_session_id: sceneSessionId,
      turn_no: turnNo,
      scene_turn_no: sceneTurnNo,
      event_type: normalizeString(input.log_event_type),
      media_signature: mediaSignature,
      uuid,
      panel_message_id: panelMessageId,
      price_xtr: normalizeNonNegativeInteger(input.log_price_xtr) ?? 0,
      access_mode: accessMode,
      action_kind: actionKind,
      fulfillment_invoice_token: fulfillmentToken,
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

    const updatedCount = await runRepositoryOperation(
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
    const abTest = parseJsonObject(input.ab_test) ?? {};
    const abTestKey = normalizeString(
      typeof abTest.key === "string" ? abTest.key : null,
    );
    const abTestStartsAt = normalizeString(
      typeof abTest.starts_at === "string" ? abTest.starts_at : null,
    );
    const abTestVersion = normalizeString(
      typeof abTest.version === "string" ? abTest.version : null,
    );
    const abTestVariant = normalizeString(
      typeof abTest.variant === "string" ? abTest.variant : null,
    );
    const deliveredAbTest =
      abTestKey && abTestStartsAt && abTestVersion && abTestVariant
        ? {
            key: abTestKey,
            starts_at: abTestStartsAt,
            version: abTestVersion,
            variant: abTestVariant,
          }
        : null;
    const abDeliveredEventsInserted = deliveredAbTest
      ? await runRepositoryOperation(
        "subscription.recordAbTestDelivered",
        {
          chat_id: chatId,
          payment_kind: null,
          sku: null,
          invoice_status: null,
        },
        () => this.repository.recordAbTestDelivered({
          chat_id: chatId,
          scene_session_id: normalizeString(input.scene_session_id),
          turn_no: normalizeNonNegativeInteger(input.turn_no),
          scene_turn_no: normalizeNonNegativeInteger(input.scene_turn_no),
          ab_test: deliveredAbTest,
        }),
      )
      : 0;

    return {
      ...base,
      operation: "subscription_offer_finalized",
      chat_id: chatId,
      offer_message_id: offerMessageId,
      subscription_invoice_tokens: tokens,
      offer_sent: updatedCount > 0,
      offer_reused: false,
      stored_count: updatedCount,
      inserted_count: abDeliveredEventsInserted,
      ab_test: deliveredAbTest,
      reason:
        updatedCount > 0
          ? "subscription_offer_message_stored"
          : "subscription_offer_message_already_stored",
    };
  }
}

