import type { VideoDelivery } from '../../modules/media/videoRepository.js';
import { config } from '../../config.js';
import { getMediaLanguage, getMediaPaymentMethods, getMediaUxCopy } from '../../mediaLocalization.js';
import { normalizePaymentSource } from '../../modules/commerce/paymentFlow.js';
import { normalizeNonNegativeInteger, normalizePositiveInteger, normalizeString, parseJsonObject } from '../../mediaCommerce/utils.js';
import { parseStrictJsonObject } from '../../mediaCommerceRepository/shared.js';
import { MediaRepositoryContractError } from '../../mediaCommerceRepository/errors.js';
import type { CommerceProduct, MediaCommerceDecisionResponse, MediaOfferItem, MediaPaymentOption, PaymentCurrency, PaymentSource, PaidInvoiceToken, StoredInvoiceToken } from '../../mediaCommerceTypes.js';
import { buildSbpGatewayCheckoutUrl } from '../../modules/commerce/checkout.js';
import type { FeaturePaymentAction } from '../../modules/commerce/paymentLifecycle.js';

export function normalizePaymentCurrency(
  value: string | null | undefined,
): PaymentCurrency | null {
  return value === "RUB" ? "RUB" : value === "XTR" ? "XTR" : null;
}

export function getSourceSortOrder(source: PaymentSource | null | undefined): number {
  const order = getMediaPaymentMethods();
  const index = source == null ? -1 : order.indexOf(source);
  return index >= 0 ? index : order.length;
}

/** Project immutable invoice quotes without exposing another checkout/action. */
export function paymentOptionPrices(options: MediaPaymentOption[]): NonNullable<CommerceProduct['prices']> {
  return options.map(({source, amount, currency, original_amount, discount_percent}) =>
    ({source, amount, currency, original_amount, ...(discount_percent != null ? {discount_percent} : {})}));
}

export function renderUx(
  template: string | null | undefined,
  values: Record<string, string | number> = {},
): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    String(template ?? ""),
  );
}

export function sourcePhotoUrl(bucket: string | null | undefined,path: string | null | undefined): string | null {
  const cleanPath=path?.trim().replace(/^\/+/,"")??"";
  const raw=bucket?.trim()??"";
  const resolved=config.MEDIA_BUCKET_ALIAS_MAP_JSON[raw.toLowerCase()]??raw;
  return cleanPath&&resolved ? `${config.MEDIA_STORAGE_BASE_URL.replace(/\/+$/u,"")}/storage/v1/object/public/${resolved}/${cleanPath}` : null;
}

export function buildPaymentOption(row: StoredInvoiceToken): MediaPaymentOption {
  const paymentSource = normalizePaymentSource(row.payment_source);
  if (!paymentSource) {
    throw new MediaRepositoryContractError("buildPaymentOption", {
      field: "payment_source",
      reason: "invalid",
    });
  }

  const paymentCurrency = normalizePaymentCurrency(row.currency);
  if (!paymentCurrency) {
    throw new MediaRepositoryContractError("buildPaymentOption", {
      field: "currency",
      reason: "invalid",
    });
  }

  const amount = normalizePositiveInteger(row.amount);
  if (amount == null) {
    throw new MediaRepositoryContractError("buildPaymentOption", {
      field: "amount",
      reason: "invalid",
    });
  }

  const checkoutUrl = paymentSource === "stars"
    ? normalizeString(row.checkout_url) ?? normalizeString(row.invoice_link)
    : normalizeString(row.checkout_url);
  if (!checkoutUrl) {
    throw new MediaRepositoryContractError("buildPaymentOption", {
      field: paymentSource === "stars" ? "checkout_url/invoice_link" : "checkout_url",
      reason: "missing",
    });
  }

  const payload = parseStrictJsonObject(row.payload_json, "buildPaymentOption");

  return {
    token: row.token,
    source: paymentSource,
    amount,
    currency: paymentCurrency,
    checkout_url: checkoutUrl,
    external_payment_id: normalizeString(row.external_payment_id),
    sku: row.sku,
    action_kind:
      typeof payload.action_kind === "string"
        ? payload.action_kind
        : row.action_kind ?? null,
    payment_kind:
      payload.action_kind === "subscription_payment"
        ? "subscription" as const
        : payload.action_kind === "feature_payment"
          ? "feature" as const
          : payload.action_kind === "photo_payment"
            ? "photo" as const
          : null,
    feature_key:
      typeof payload.feature_key === "string"
        ? payload.feature_key
        : null,
    scene_session_id: row.scene_session_id,
    sort_order: normalizeNonNegativeInteger(payload.sort_order) ?? 100,
    subscription_days:
      normalizePositiveInteger(payload.subscription_days) ?? null,
    original_amount:
      paymentSource === "sbp"
        ? normalizePositiveInteger(payload.original_amount_rub)
        : normalizePositiveInteger(payload.original_amount_xtr),
    ...(payload.purchase_variant === 'scene_unlock_upgrade'
      ? {discount_percent: normalizeNonNegativeInteger(payload.discount_percent) ?? 0} : {}),
    promo_key:
      normalizeString(
        typeof payload.promo_key === "string"
          ? payload.promo_key
          : null,
      ) ?? null,
    title: row.invoice_title,
    description: row.invoice_description,
    label: row.invoice_label,
    button_text: row.invoice_button_text,
  };
}

export function buildOfferItem(rows: StoredInvoiceToken[]): MediaOfferItem | null {
  if (rows.length === 0) {
    return null;
  }

  const sortedRows = rows
    .slice()
    .sort((left, right) =>
      getSourceSortOrder(normalizePaymentSource(left.payment_source))
      - getSourceSortOrder(normalizePaymentSource(right.payment_source))
      || (normalizeNonNegativeInteger(left.payload_json.sort_order) ?? 100)
      - (normalizeNonNegativeInteger(right.payload_json.sort_order) ?? 100),
    );
  const primaryRow = sortedRows[0] ?? rows[0];
  if (!primaryRow) {
    return null;
  }
  const payload = parseStrictJsonObject(primaryRow.payload_json, "buildOfferItem");

  return {
    sku: primaryRow.sku,
    action_kind:
      typeof payload.action_kind === "string"
        ? payload.action_kind
        : primaryRow.action_kind ?? null,
    payment_kind:
      payload.action_kind === "subscription_payment"
        ? "subscription"
        : payload.action_kind === "feature_payment"
          ? "feature"
          : payload.action_kind === "photo_payment"
            ? "photo"
            : null,
    feature_key:
      typeof payload.feature_key === "string"
        ? payload.feature_key
        : null,
    scene_session_id: primaryRow.scene_session_id,
    sort_order: normalizeNonNegativeInteger(payload.sort_order) ?? 100,
    subscription_days:
      normalizePositiveInteger(payload.subscription_days) ?? null,
    promo_key:
      normalizeString(
        typeof payload.promo_key === "string"
          ? payload.promo_key
          : null,
      ) ?? null,
    title: primaryRow.invoice_title,
    description: primaryRow.invoice_description,
    label: primaryRow.invoice_label,
    payment_options: sortedRows.map((row) => buildPaymentOption(row)),
  };
}

export function buildOfferGroupKey(row: StoredInvoiceToken): string {
  const payload = parseStrictJsonObject(row.payload_json, "buildOfferGroupKey");

  return JSON.stringify([
    normalizeString(row.action_kind) ?? null,
    normalizeString(row.sku) ?? null,
    normalizeString(row.scene_session_id) ?? null,
    normalizeString(
      typeof payload.feature_key === "string" ? payload.feature_key : null,
    ) ?? null,
    normalizePositiveInteger(payload.subscription_days) ?? null,
    normalizeNonNegativeInteger(payload.sort_order) ?? 100,
  ]);
}

export function videoPaymentCleanupUrls(urls: unknown, paymentToken: string | null | undefined, markup?: unknown): string[] {
  const result = normalizeInvoiceTokens(urls);
  const token = normalizeString(paymentToken);
  if (config.SBP_ENABLED && token && /:(?:stars|sbp)$/u.test(token)) {
    result.push(buildSbpGatewayCheckoutUrl(token.replace(/:(?:stars|sbp)$/u, ':sbp')));
  }
  const baseUrl = normalizeString(config.GATEWAY_PUBLIC_URL);
  const keyboard = parseJsonObject(markup)?.inline_keyboard;
  if (config.SBP_ENABLED && baseUrl && Array.isArray(keyboard)) {
    const prefix = `${baseUrl}/v1/pay/sbp/`;
    for (const button of keyboard.flat()) {
      const rawUrl = parseJsonObject(button)?.url;
      const url = typeof rawUrl === 'string' ? normalizeString(rawUrl) : null;
      if (url?.startsWith(prefix)) result.push(url);
    }
  }
  return Array.from(new Set(result));
}

export function groupOfferItems(rows: StoredInvoiceToken[]): MediaOfferItem[] {
  const grouped = new Map<string, StoredInvoiceToken[]>();

  for (const row of rows) {
    const key = buildOfferGroupKey(row);
    const existing = grouped.get(key);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }

  return Array.from(grouped.values())
    .map((rows) => buildOfferItem(rows))
    .filter((item): item is MediaOfferItem => item != null)
    .sort(
      (left, right) =>
        (normalizeNonNegativeInteger(left.sort_order) ?? 100)
        - (normalizeNonNegativeInteger(right.sort_order) ?? 100)
        || (normalizePositiveInteger(left.subscription_days) ?? 0)
        - (normalizePositiveInteger(right.subscription_days) ?? 0),
    );
}

export function getFirstAvailablePaymentSource(items: MediaOfferItem[]): PaymentSource {
  const available = new Set(
    items.flatMap((item) => item.payment_options.map((option) => option.source)),
  );
  // Legacy selected_payment_source is a projection, not an eligibility filter.
  // All authorized options remain available to the Telegram renderer.
  const order: PaymentSource[] = getMediaLanguage() === 'en' ? ['stars', 'sbp'] : getMediaPaymentMethods();
  return order.find((source) => available.has(source))
    ?? (available.has("sbp") ? "sbp" : "stars");
}

export function selectLegacyPrimaryRow(rows: StoredInvoiceToken[]): StoredInvoiceToken | null {
  if (rows.length === 0) {
    return null;
  }

  const starsRow = rows.find(
    (row) => normalizePaymentSource(row.payment_source) === "stars",
  );
  return starsRow ?? rows[0] ?? null;
}

export function buildTopLevelPaymentFields(
  rows: StoredInvoiceToken[],
): Pick<
  MediaCommerceDecisionResponse,
  | "payment_source"
  | "payment_amount"
  | "payment_currency"
  | "checkout_url"
  | "external_payment_id"
  | "invoice_token"
  | "invoice_link"
  | "payment_options"
> {
  const primary = selectLegacyPrimaryRow(rows);

  return {
    payment_source: primary ? normalizePaymentSource(primary.payment_source) : null,
    payment_amount:
      primary != null
        ? normalizeNonNegativeInteger(primary.amount ?? primary.amount_xtr)
        : null,
    payment_currency: primary?.currency ?? null,
    checkout_url:
      primary != null
        ? normalizeString(primary.checkout_url) ?? normalizeString(primary.invoice_link)
        : null,
    external_payment_id:
      primary != null ? normalizeString(primary.external_payment_id) : null,
    invoice_token: primary?.token ?? null,
    invoice_link:
      primary != null && normalizePaymentSource(primary.payment_source) === "stars"
        ? normalizeString(primary.checkout_url) ?? normalizeString(primary.invoice_link)
        : null,
    payment_options: rows.map((row) => buildPaymentOption(row)).sort(
      (left, right) =>
        getSourceSortOrder(left.source) - getSourceSortOrder(right.source),
    ),
  };
}

export function deliveryResponse(base: MediaCommerceDecisionResponse, delivery: VideoDelivery | null): MediaCommerceDecisionResponse {
    if (!delivery) return {...base,operation:'noop',reason:'video_access_required'};
    if (delivery.status === 'duplicate_payment_requires_review' || !delivery.delivery_id) {
      return {...base,operation:'video_payment_review_required',reason:'duplicate_payment_requires_review',
        text:renderUx(getMediaUxCopy().video?.duplicate_payment_review)};
    }
    return {...base,operation:['queued','pending','failed','ready'].includes(delivery.status) ? 'video_delivery_required' : 'noop',
      delivery_id:delivery.delivery_id,eligible_at:delivery.eligible_at,target_message_id:delivery.photo_message_id,
      telegram_chat_id:delivery.telegram_chat_id,requested_photo_uuid:delivery.requested_photo_uuid,
      source_photo_uuid:delivery.source_photo_uuid,source_photo_reveal_at:delivery.source_photo_reveal_at,
      source_photo_url:sourcePhotoUrl(delivery.source_photo_bucket_name,delivery.source_photo_storage_path),
      panel_caption:delivery.panel_caption,panel_caption_entities:delivery.panel_caption_entities,
      same_photo:delivery.same_photo,reason:`video_delivery_${delivery.status}`};
  }

export function buildFeatureFulfillmentResponse(base: MediaCommerceDecisionResponse,
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

export function normalizeInvoiceTokens(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.map((item) => normalizeString(item)).filter(
      (item): item is string => item != null,
    )))
    : [];
}
