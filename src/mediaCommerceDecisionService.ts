import { createHash } from "node:crypto";
import {
  buildAssignment,
  chooseVariant,
  findActiveExperiment,
  parseAbTestAssignment,
  toAbTestContext,
  type AbTestContext,
  type AbTestSelection,
  type SubscriptionOfferExperimentParams,
} from "./abTesting.js";
import { config } from "./config.js";
import {
  buildCallbackTokenRow,
  buildMediaAction,
  buildPhotoInvoiceInput,
  calculateMediaPriceRequired,
} from "./mediaCommerce/mediaAction.js";
import {
  INVOICE_PAYLOAD_KIND,
  hasExpectedPaymentDetails,
  normalizePaymentSource,
  type ResolvedInvoiceAction,
  resolveInvoiceActionResult,
  toPaidInvoiceToken,
  validatePrecheckout,
} from "./mediaCommerce/paymentFlow.js";
import {
  buildBaseResponse,
} from "./mediaCommerce/responseBuilders.js";
import {
  buildFeaturePaymentInputs,
  buildSceneUnlockPaymentInputs,
  buildSubscriptionPaymentInputs,
} from "./mediaCommerce/subscriptionFlow.js";
import {
  resolveSubscriptionPlans,
  resolveActionPlanByFeatureKey,
  resolvePhotoPlanByAmount,
} from "./mediaCommerce/plans.js";
import {
  INVOICE_TTL_MS,
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
import type { MediaCommerceDecisionRequest } from "./mediaCommerce/requestSchema.js";
import { getRequestContext } from "./requestContext.js";
import {
  TelegramStarsPaymentAdapter,
  type StarsInvoiceClient,
} from "./payments/stars.js";
import {
  SbpPaymentAdapter,
  type SbpPaymentClient,
} from "./payments/sbp.js";
import type {
  MediaCommerceDecisionResponse,
  MediaCommerceRoute,
  InteractionTokenRow,
  MediaContext,
  MediaOfferItem,
  MediaPaymentOption,
  MediaSubscriptionOfferReason,
  MediaOfferStats,
  PaymentUiCopy,
  PaymentCurrency,
  PaymentSource,
  PaidInvoiceToken,
  StoredInvoiceToken,
  TelegramMessageKind,
} from "./mediaCommerceTypes.js";

type MediaRepository = Pick<
  MediaCommerceRepository,
  | "loadOfferStats"
  | "upsertCallbackTokens"
  | "upsertInvoiceToken"
  | "upsertInvoiceTokens"
  | "loadCallbackToken"
  | "loadMediaContext"
  | "storePanel"
  | "loadInvoiceToken"
  | "loadInvoiceTokenByExternalPaymentId"
  | "storePrecheckoutResult"
  | "markInvoicePaid"
  | "activateSubscription"
  | "activateSceneAccess"
  | "loadSceneAccessStatus"
  | "loadFreeCredits"
  | "redeemFreeFastSceneSkip"
  | "redeemFreeSceneUnlock"
  | "storePhotoEvent"
  | "storeInvoiceLinks"
  | "claimSbpCheckoutCreation"
  | "releaseSbpCheckoutCreation"
  | "loadStoredInvoiceTokens"
  | "loadAbTestAssignment"
  | "storeAbTestAssignment"
  | "recordAbTestDelivered"
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

type PaymentUiActionKind =
  | "reveal_feature_payment_options"
  | "subscription_payment_source_toggle";

function normalizePaymentCurrency(
  value: string | null | undefined,
): PaymentCurrency | null {
  return value === "RUB" ? "RUB" : value === "XTR" ? "XTR" : null;
}

function getSourceSortOrder(source: PaymentSource | null | undefined): number {
  return source === "sbp" ? 0 : source === "stars" ? 1 : 2;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const SBP_CHECKOUT_WAIT_TIMEOUT_MS = 24_000;
const SBP_CHECKOUT_WAIT_BACKOFF_MS = [200, 400, 800, 1000, 1500, 2000] as const;
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
  action_kind: "free_fast_scene_skip" | "free_scene_unlock";
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
  feature_key: "fast_scene_skip" | "scene_unlock";
  action_button_text: string;
  ab_test?: AbTestContext | null;
}): InteractionTokenRow {
  const token = buildStableCallbackToken([
    input.action_kind,
    input.chat_id,
    input.scene_session_id,
    input.turn_no,
    input.scene_turn_no,
    input.target_message_id,
    input.feature_key,
  ]);

  return {
    token,
    kind: "button_callback",
    chat_id: input.chat_id,
    scene_session_id: input.scene_session_id,
    turn_no: input.turn_no,
    payload_json: {
      action_kind: input.action_kind,
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
      feature_key: input.feature_key,
      requested_action:
        input.feature_key === "fast_scene_skip"
          ? "fast_scene_skip_free"
          : "scene_unlock_free",
      action_button_text: input.action_button_text,
      ab_test: input.ab_test ?? null,
    },
    status: "active",
    action_kind: input.action_kind,
    expires_at: new Date(Date.now() + FREE_CALLBACK_TTL_MS).toISOString(),
  };
}

function buildPaymentUiCopy(): PaymentUiCopy {
  return { ...config.TELEGRAM_UX_COPY_JSON.payment_ui };
}

function getFeaturePaymentHint(featureKey: string | null | undefined): string | null {
  if (featureKey === "fast_scene_skip") {
    return config.TELEGRAM_UX_COPY_JSON.payment_ui.fast_scene_skip_hint;
  }

  if (featureKey === "scene_unlock") {
    return config.TELEGRAM_UX_COPY_JSON.payment_ui.scene_unlock_hint;
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

function buildPaymentUiTokenRow(input: {
  action_kind: PaymentUiActionKind;
  chat_id: number;
  scene_session_id: string | null;
  turn_no: number | null;
  scene_turn_no: number | null;
  target_message_id?: number | null;
  feature_key?: "fast_scene_skip" | "scene_unlock" | string | null;
  action_button_text?: string | null;
  payment_options?: MediaPaymentOption[];
  subscription_offer_items?: MediaOfferItem[];
  token_rows?: InteractionTokenRow[];
  text?: string | null;
  offer_message_id?: number | null;
  selected_payment_source?: PaymentSource | null;
  payment_source_toggle_tokens?: Partial<Record<PaymentSource, string>> | null;
  ab_test?: AbTestContext | null;
  idempotency_key?: string | null;
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

  return {
    token,
    kind: "button_callback",
    chat_id: input.chat_id,
    scene_session_id: input.scene_session_id,
    turn_no: input.turn_no,
    payload_json: {
      action_kind: input.action_kind,
      chat_id: input.chat_id,
      scene_session_id: input.scene_session_id,
      turn_no: input.turn_no,
      scene_turn_no: input.scene_turn_no,
      target_message_id: input.target_message_id ?? null,
      feature_key: input.feature_key ?? null,
      requested_action: input.action_kind,
      action_button_text: input.action_button_text ?? null,
      payment_options: input.payment_options ?? [],
      subscription_offer_items: input.subscription_offer_items ?? [],
      token_rows: input.token_rows ?? [],
      text: input.text ?? null,
      offer_message_id: input.offer_message_id ?? null,
      selected_payment_source: input.selected_payment_source ?? null,
      payment_source_toggle_tokens: input.payment_source_toggle_tokens ?? null,
      feature_payment_hint_text: getFeaturePaymentHint(input.feature_key),
      payment_ui: buildPaymentUiCopy(),
      ab_test: input.ab_test ?? null,
    },
    status: "active",
    action_kind: input.action_kind,
    expires_at: new Date(Date.now() + INVOICE_TTL_MS).toISOString(),
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

function applySubscriptionPlanOverrides<T extends {
  sku: string;
  amount_xtr: number;
  amount_rub?: number | null;
  days?: number;
  title: string;
  description: string;
  label: string;
  button_text: string;
}>(
  plans: T[],
  params: SubscriptionOfferExperimentParams,
): T[] {
  const overrides = new Map(
    (params.plans ?? []).map((override) => [override.sku, override]),
  );

  return plans.flatMap((plan) => {
    const override = overrides.get(plan.sku);
    if (override?.enabled === false) {
      return [];
    }

    return [{
      ...plan,
      days: override?.days ?? plan.days,
      amount_xtr: override?.amount_xtr ?? plan.amount_xtr,
      amount_rub:
        "amount_rub" in (override ?? {})
          ? override?.amount_rub ?? null
          : plan.amount_rub ?? null,
      title: override?.title ?? plan.title,
      description: override?.description ?? plan.description,
      label: override?.label ?? plan.label,
      button_text: override?.button_text ?? plan.button_text,
    } as T];
  });
}

function applySceneUnlockOverride<T extends {
  amount_xtr: number;
  amount_rub?: number | null;
  title: string;
  description: string;
  label: string;
  button_text: string;
}>(
  plan: T | null,
  params: SubscriptionOfferExperimentParams,
): T | null {
  if (!plan || params.scene_unlock?.enabled === false) {
    return null;
  }

  const override = params.scene_unlock;
  return {
    ...plan,
    amount_xtr: override?.amount_xtr ?? plan.amount_xtr,
    amount_rub:
      override && "amount_rub" in override
        ? override.amount_rub ?? null
        : plan.amount_rub ?? null,
    title: override?.title ?? plan.title,
    description: override?.description ?? plan.description,
    label: override?.label ?? plan.label,
    button_text: override?.button_text ?? plan.button_text,
  };
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

function buildPaymentOption(row: StoredInvoiceToken): MediaPaymentOption {
  const paymentSource = normalizePaymentSource(row.payment_source) ?? "stars";
  const paymentCurrency = normalizePaymentCurrency(row.currency)
    ?? (paymentSource === "sbp" ? "RUB" : "XTR");
  const payload = parseJsonObject(row.payload_json) ?? {};

  return {
    token: row.token,
    source: paymentSource,
    amount: normalizeNonNegativeInteger(row.amount ?? row.amount_xtr) ?? 0,
    currency: paymentCurrency,
    checkout_url:
      normalizeString(row.checkout_url)
      ?? normalizeString(row.invoice_link)
      ?? "",
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

function buildOfferItem(rows: StoredInvoiceToken[]): MediaOfferItem | null {
  if (rows.length === 0) {
    return null;
  }

  const sortedRows = rows
    .slice()
    .sort((left, right) =>
      getSourceSortOrder(normalizePaymentSource(left.payment_source))
      - getSourceSortOrder(normalizePaymentSource(right.payment_source))
      || Number(left.payload_json.sort_order ?? 100)
      - Number(right.payload_json.sort_order ?? 100),
    );
  const primaryRow = sortedRows[0] ?? rows[0];
  const payload = parseJsonObject(primaryRow?.payload_json) ?? {};

  if (!primaryRow) {
    return null;
  }

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

function buildOfferGroupKey(row: StoredInvoiceToken): string {
  const payload = parseJsonObject(row.payload_json) ?? {};

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

function groupOfferItems(rows: StoredInvoiceToken[]): MediaOfferItem[] {
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
        Number(left.sort_order ?? 100) - Number(right.sort_order ?? 100)
        || Number(left.subscription_days ?? 0) - Number(right.subscription_days ?? 0),
    );
}

function selectLegacyPrimaryRow(rows: StoredInvoiceToken[]): StoredInvoiceToken | null {
  if (rows.length === 0) {
    return null;
  }

  const starsRow = rows.find(
    (row) => normalizePaymentSource(row.payment_source) === "stars",
  );
  return starsRow ?? rows[0] ?? null;
}

function buildTopLevelPaymentFields(
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

type OperationLogContext = {
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
  if (eventType === "payment.success.received" || eventType === "payment.confirmed.received") {
    return "payment_success";
  }
  return "noop";
}

export class MediaCommerceDecisionService {
  constructor(
    private readonly repository: MediaRepository,
    private readonly starsClient: StarsInvoiceClient = new TelegramStarsPaymentAdapter(),
    private readonly sbpClient: SbpPaymentClient | null = config.SBP_ENABLED
      ? new SbpPaymentAdapter()
      : null,
  ) {}

  private async runOperation<T>(
    operation: string,
    context: OperationLogContext,
    execute: () => Promise<T>,
  ): Promise<T> {
    const requestId = getRequestContext()?.requestId ?? null;
    const startedAt = Date.now();

    try {
      return await execute();
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

  private async runRepositoryOperation<T>(
    operation: string,
    context: OperationLogContext,
    execute: () => Promise<T>,
  ): Promise<T> {
    return this.runOperation(operation, context, execute);
  }

  private async ensureStarsInvoiceLink(
    row: StoredInvoiceToken,
    operationPrefix: string,
  ): Promise<StoredInvoiceToken> {
    const existingLink =
      normalizeString(row.checkout_url)
      ?? normalizeString(row.invoice_link);
    if (existingLink) {
      return {
        ...row,
        checkout_url: existingLink,
        invoice_link: existingLink,
      };
    }

    const token = normalizeString(row.token);
    const chatId = normalizePositiveInteger(row.chat_id);
    const payload = normalizeString(row.telegram_invoice_payload);
    const amountXtr = normalizePositiveInteger(row.amount_xtr);
    const title = normalizeString(row.invoice_title);
    const description = normalizeString(row.invoice_description);
    const label = normalizeString(row.invoice_label);

    if (!token || !chatId || !payload || !amountXtr || !title || !description || !label) {
      throw new MediaCommerceOperationError(
        "Stored invoice row is incomplete",
        `${operationPrefix}.createInvoiceLink`,
        "stars_invoice_creation_failed",
      );
    }

    const context = {
      chat_id: chatId,
      payment_kind: normalizeString(row.action_kind),
      sku: normalizeString(row.sku),
      invoice_status: normalizeString(row.status),
    };
    const created = await this.runOperation(
      `${operationPrefix}.createInvoiceLink`,
      context,
      () => this.starsClient.createStarsInvoice({
        title,
        description,
        payload,
        label,
        amount_xtr: amountXtr,
      }),
    );

    await this.runRepositoryOperation(
      `${operationPrefix}.storeInvoiceLink`,
      context,
      () => this.repository.storeInvoiceLinks([{
        token,
        chat_id: chatId,
        invoice_link: created.invoice_link,
        checkout_url: created.invoice_link,
        external_payment_id: null,
      }]),
    );

    return {
      ...row,
      checkout_url: created.invoice_link,
      invoice_link: created.invoice_link,
    };
  }

  private async ensureSbpCheckout(
    row: StoredInvoiceToken,
    operationPrefix: string,
  ): Promise<StoredInvoiceToken> {
    const existingCheckout = normalizeString(row.checkout_url);
    const existingExternalPaymentId = normalizeString(row.external_payment_id);
    if (existingCheckout && existingExternalPaymentId) {
      return {
        ...row,
        checkout_url: existingCheckout,
        external_payment_id: existingExternalPaymentId,
      };
    }

    if (!this.sbpClient) {
      throw new MediaCommerceOperationError(
        "SBP adapter is not configured",
        `${operationPrefix}.createPayment`,
        "sbp_payment_creation_failed",
      );
    }

    const token = normalizeString(row.token);
    const chatId = normalizePositiveInteger(row.chat_id);
    const sku = normalizeString(row.sku);
    const amountRub = normalizePositiveInteger(row.amount);
    const title = normalizeString(row.invoice_title);
    const description = normalizeString(row.invoice_description);
    if (!token || !chatId || !sku || !amountRub || !title || !description) {
      throw new MediaCommerceOperationError(
        "Stored SBP row is incomplete",
        `${operationPrefix}.createPayment`,
        "sbp_payment_creation_failed",
      );
    }

    const claimContext = {
      chat_id: chatId,
      payment_kind: normalizeString(row.action_kind),
      sku,
      invoice_status: normalizeString(row.status),
    };
    let claim = await this.runRepositoryOperation(
      `${operationPrefix}.claimSbpCheckoutCreation`,
      claimContext,
      () => this.repository.claimSbpCheckoutCreation(token, chatId),
    );
    const waitStartedAt = Date.now();
    let pollIndex = 0;

    while (true) {
      const claimedCheckout = normalizeString(claim?.checkout_url);
      const claimedExternalPaymentId = normalizeString(claim?.external_payment_id);
      if (claimedCheckout && claimedExternalPaymentId) {
        return {
          ...row,
          checkout_url: claimedCheckout,
          external_payment_id: claimedExternalPaymentId,
        };
      }

      if (claim?.claim_acquired) {
        break;
      }

      const remainingMs = SBP_CHECKOUT_WAIT_TIMEOUT_MS - (Date.now() - waitStartedAt);
      if (remainingMs <= 0) {
        throw new MediaCommerceOperationError(
          "SBP checkout creation is already in progress",
          `${operationPrefix}.createPayment`,
          "sbp_payment_creation_failed",
        );
      }

      const delayMs = Math.min(
        SBP_CHECKOUT_WAIT_BACKOFF_MS[pollIndex] ?? 2000,
        remainingMs,
      );
      pollIndex += 1;
      await sleep(delayMs);

      claim = await this.runRepositoryOperation(
        `${operationPrefix}.claimSbpCheckoutCreation`,
        claimContext,
        () => this.repository.claimSbpCheckoutCreation(token, chatId),
      );
    }

    let created: { external_payment_id: string; checkout_url: string };
    try {
      created = await this.runOperation(
        `${operationPrefix}.createPayment`,
        {
          chat_id: chatId,
          payment_kind: normalizeString(row.action_kind),
          sku,
          invoice_status: normalizeString(row.status),
        },
        () => this.sbpClient!.createPayment({
          token,
          chat_id: chatId,
          sku,
          title,
          description,
          amount_rub: amountRub,
          metadata: {
            scene_session_id: row.scene_session_id,
            action_kind: row.action_kind ?? null,
          },
        }),
      );
    } catch (error) {
      await this.runRepositoryOperation(
        `${operationPrefix}.releaseSbpCheckoutCreation`,
        {
          chat_id: chatId,
          payment_kind: normalizeString(row.action_kind),
          sku,
          invoice_status: normalizeString(row.status),
        },
        () => this.repository.releaseSbpCheckoutCreation(token, chatId),
      );
      throw error;
    }

    await this.runRepositoryOperation(
      `${operationPrefix}.storeCheckout`,
      {
        chat_id: chatId,
        payment_kind: normalizeString(row.action_kind),
        sku,
        invoice_status: normalizeString(row.status),
      },
      () => this.repository.storeInvoiceLinks([{
        token,
        chat_id: chatId,
        invoice_link: null,
        checkout_url: created.checkout_url,
        external_payment_id: created.external_payment_id,
      }]),
    );

    return {
      ...row,
      checkout_url: created.checkout_url,
      external_payment_id: created.external_payment_id,
    };
  }

  private async ensureStoredPaymentReady(
    row: StoredInvoiceToken,
    operationPrefix: string,
  ): Promise<StoredInvoiceToken> {
    return normalizePaymentSource(row.payment_source) === "sbp"
      ? this.ensureSbpCheckout(row, operationPrefix)
      : this.ensureStarsInvoiceLink(row, operationPrefix);
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
    const sceneAccessActive = stats.scene_access_active === true;
    const totalAvailable = Number(stats.total_available ?? 0);
    const unseenAvailable = Number(stats.unseen_available ?? 0);
    const existingPanel = normalizePositiveInteger(stats.existing_panel_message_id);
    const basePrice = Number(stats.base_price_xtr ?? 10);
    const priceRequired = calculateMediaPriceRequired({
      subscription_active: subscriptionActive,
      scene_access_active: sceneAccessActive,
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
      const canOfferSceneUnlock =
        !subscriptionActive && !sceneAccessActive && Boolean(stats.scene_session_id);
      const freeCredits = canOfferSceneUnlock
        ? await this.repository.loadFreeCredits(stats.chat_id)
        : null;
      const freeSceneUnlockButton =
        config.TELEGRAM_UX_COPY_JSON.free_actions?.scene_unlock_button;
      const freeSceneUnlockTokenRows =
        canOfferSceneUnlock
        && stats.scene_session_id
        && freeSceneUnlockButton
        && Math.max(0, Number(freeCredits?.free_scene_unlocks ?? 0)) > 0
          ? [
              buildFreeActionTokenRow({
                action_kind: "free_scene_unlock",
                chat_id: stats.chat_id,
                scene_session_id: stats.scene_session_id,
                turn_no: stats.turn_no,
                scene_turn_no: stats.scene_turn_no,
                media_signature: mediaSignature,
                target_message_id: null,
                current_uuid: null,
                base_price_xtr: basePrice,
                feature_key: "scene_unlock",
                action_button_text: freeSceneUnlockButton,
              }),
            ]
          : [];
      const sceneUnlockPlan =
        canOfferSceneUnlock && freeSceneUnlockTokenRows.length === 0
          ? resolveActionPlanByFeatureKey("scene_unlock")
          : null;
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
      const storedSceneUnlockInvoice =
        sceneUnlockPlan && stats.scene_session_id
          ? await this.repository.upsertInvoiceTokens(
            buildSceneUnlockPaymentInputs({
              chat_id: stats.chat_id,
              scene_session_id: stats.scene_session_id,
              idempotency_key: `scene:${stats.chat_id}:${stats.scene_session_id}`,
              turn_limit: config.TURN_LIMIT,
              target_message_id: null,
              plan: sceneUnlockPlan,
            }),
          )
          : [];
      const tokenRowsInserted = freeSceneUnlockTokenRows.length > 0
        ? await this.repository.upsertCallbackTokens(freeSceneUnlockTokenRows)
        : 0;
      const photoLinkWasReused = normalizeString(storedInvoice?.invoice_link) != null;
      const [
        linkedInvoice,
        linkedSceneUnlockInvoice,
      ] = await Promise.all([
        storedInvoice
          ? this.ensureStoredPaymentReady(storedInvoice, "prepareOffer.photo")
          : Promise.resolve(null),
        storedSceneUnlockInvoice.length > 0
          ? Promise.all(
            storedSceneUnlockInvoice.map((row) =>
              this.ensureStoredPaymentReady(row, "prepareOffer.sceneUnlock")),
          )
          : Promise.resolve([]),
      ]);
      const topLevelPayment = linkedInvoice
        ? buildTopLevelPaymentFields([linkedInvoice])
        : buildTopLevelPaymentFields([]);

      return {
        ...base,
        chat_id: stats.chat_id,
        scene_session_id: stats.scene_session_id,
        turn_no: stats.turn_no,
        scene_turn_no: stats.scene_turn_no,
        media_signature: mediaSignature,
        base_price_xtr: basePrice,
        price_required: priceRequired,
        operation: "prepare_offer_ready",
        has_media_offer: true,
        invoice_kind: "photo",
        invoice_sku: linkedInvoice?.sku ?? photoPlan.sku,
        invoice_amount: linkedInvoice?.amount_xtr ?? photoPlan.amount_xtr,
        original_invoice_amount:
          normalizePositiveInteger(linkedInvoice?.payload_json.original_amount_xtr)
          ?? photoPlan.original_amount_xtr,
        promo_key:
          normalizeString(
            typeof linkedInvoice?.payload_json.promo_key === "string"
              ? linkedInvoice.payload_json.promo_key
              : null,
          )
          ?? photoPlan.promo_key,
        invoice_title: linkedInvoice?.invoice_title ?? photoPlan.title,
        invoice_description:
          linkedInvoice?.invoice_description ?? photoPlan.description,
        invoice_label: linkedInvoice?.invoice_label ?? photoPlan.label,
        invoice_button_text:
          linkedInvoice?.invoice_button_text ?? photoPlan.button_text,
        invoice_payload_json: invoicePayload,
        ...topLevelPayment,
        token_rows: freeSceneUnlockTokenRows,
        token_rows_prepared: freeSceneUnlockTokenRows.length,
        token_rows_inserted: tokenRowsInserted,
        scene_unlock_offer_item: linkedSceneUnlockInvoice.length > 0
          ? buildOfferItem(linkedSceneUnlockInvoice)
          : null,
        reason: photoLinkWasReused ? "invoice_link_reused" : "invoice_link_created",
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
      button_text: config.TELEGRAM_UX_COPY_JSON.media.get_photo_button,
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
    const freeFastSkipButton =
      config.TELEGRAM_UX_COPY_JSON.free_actions?.fast_scene_skip_button;
    const freeCredits =
      featureKey === "fast_scene_skip" && freeFastSkipButton
        ? await this.repository.loadFreeCredits(chatId)
        : null;
    const sceneSessionId =
      normalizeString(input.scene_session_id)
      ?? normalizeString(freeCredits?.active_scene_session_id);
    if (featureKey === "fast_scene_skip" && sceneSessionId && freeFastSkipButton) {
      const freeFastSkips = Math.max(0, Number(freeCredits?.free_fast_scene_skips ?? 0));
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

    const actionPlan = resolveActionPlanByFeatureKey(featureKey);
    const storedFeatureInvoices = actionPlan
      ? await this.repository.upsertInvoiceTokens(
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
      )
      : [];
    const featureInvoices = await Promise.all(
      storedFeatureInvoices.map((row) => this.ensureStoredPaymentReady(row, "featureOffer")),
    );
    const featureInvoice = selectLegacyPrimaryRow(featureInvoices);
    const featurePaymentOptions = featureInvoices
      .map((row) => buildPaymentOption(row))
      .sort((left, right) => getSourceSortOrder(left.source) - getSourceSortOrder(right.source));
    const revealTokenRows =
      actionPlan && featurePaymentOptions.length > 0
        ? [
            buildPaymentUiTokenRow({
              action_kind: "reveal_feature_payment_options",
              chat_id: chatId,
              scene_session_id: normalizeString(input.scene_session_id),
              turn_no: normalizeNonNegativeInteger(input.turn_no),
              scene_turn_no: normalizeNonNegativeInteger(input.scene_turn_no),
              target_message_id: normalizePositiveInteger(input.target_message_id),
              feature_key: featureKey,
              action_button_text: actionPlan.button_text,
              payment_options: featurePaymentOptions,
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
      invoice_kind: actionPlan ? "feature" : null,
      invoice_sku: featureInvoice?.sku ?? actionPlan?.sku ?? null,
      invoice_amount: featureInvoice?.amount_xtr ?? actionPlan?.amount_xtr ?? null,
      original_invoice_amount:
        normalizePositiveInteger(featureInvoice?.payload_json.original_amount_xtr)
        ?? actionPlan?.original_amount_xtr
        ?? null,
      promo_key:
        normalizeString(
          typeof featureInvoice?.payload_json.promo_key === "string"
            ? featureInvoice.payload_json.promo_key
            : null,
        )
        ?? actionPlan?.promo_key
        ?? null,
      invoice_title: featureInvoice?.invoice_title ?? actionPlan?.title ?? null,
      invoice_description:
        featureInvoice?.invoice_description ?? actionPlan?.description ?? null,
      invoice_label: featureInvoice?.invoice_label ?? actionPlan?.label ?? null,
      invoice_button_text:
        featureInvoice?.invoice_button_text ?? actionPlan?.button_text ?? null,
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

    const valid =
      Boolean(callbackRow?.found && callbackRow?.token)
      && !isExpired(callbackRow?.expires_at)
      && normalizeString(callbackRow?.status) === "active";
    const answerText = !valid
      ? config.TELEGRAM_UX_COPY_JSON.payment_errors.stale
      : (actionKind === "photo_request" || actionKind === "photo_regen")
        ? config.TELEGRAM_UX_COPY_JSON.media.generating
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
      message_kind: rawPanel.message_kind,
      current_reply_markup: rawPanel.reply_markup,
    } satisfies MediaCommerceDecisionResponse;

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

  private evaluateRevealFeaturePaymentOptionsCallback(
    base: MediaCommerceDecisionResponse,
    payload: Record<string, unknown>,
  ): MediaCommerceDecisionResponse {
    if (base.callback_valid !== true) {
      return {
        ...base,
        operation: "noop",
        callback_valid: false,
        callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
        callback_show_alert: false,
        reason: "callback_invalid",
      };
    }

    const paymentOptions = Array.isArray(payload.payment_options)
      ? payload.payment_options.filter(
        (option): option is MediaPaymentOption =>
          option != null
          && typeof option === "object"
          && !Array.isArray(option)
          && typeof (option as { checkout_url?: unknown }).checkout_url === "string",
      )
      : [];
    const featureKey = normalizeString(
      typeof payload.feature_key === "string" ? payload.feature_key : null,
    );

    return {
      ...base,
      operation: "feature_payment_options_revealed",
      callback_valid: true,
      callback_answer_text: "",
      payment_options: paymentOptions,
      feature_key: featureKey,
      feature_payment_hint_text:
        normalizeString(
          typeof payload.feature_payment_hint_text === "string"
            ? payload.feature_payment_hint_text
            : null,
        ) ?? getFeaturePaymentHint(featureKey),
      payment_ui: buildPaymentUiCopy(),
      reason: "feature_payment_options_revealed",
    };
  }

  private evaluateSubscriptionPaymentSourceToggleCallback(
    base: MediaCommerceDecisionResponse,
    payload: Record<string, unknown>,
  ): MediaCommerceDecisionResponse {
    if (base.callback_valid !== true) {
      return {
        ...base,
        operation: "noop",
        callback_valid: false,
        callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
        callback_show_alert: false,
        reason: "callback_invalid",
      };
    }

    const selectedPaymentSource = normalizePaymentSource(
      typeof payload.selected_payment_source === "string"
        ? payload.selected_payment_source
        : null,
    );
    const offerItems = Array.isArray(payload.subscription_offer_items)
      ? payload.subscription_offer_items.filter(
        (item): item is MediaOfferItem =>
          item != null
          && typeof item === "object"
          && !Array.isArray(item)
          && Array.isArray((item as { payment_options?: unknown }).payment_options),
      )
      : [];
    const tokenRows = Array.isArray(payload.token_rows)
      ? payload.token_rows.filter(
        (row): row is InteractionTokenRow =>
          row != null
          && typeof row === "object"
          && !Array.isArray(row)
          && typeof (row as { token?: unknown }).token === "string",
      )
      : [];

    return {
      ...base,
      operation: "subscription_offer_ready",
      callback_valid: true,
      callback_answer_text: "",
      selected_payment_source: selectedPaymentSource,
      subscription_offer_items: offerItems,
      token_rows: tokenRows,
      token_rows_prepared: tokenRows.length,
      text: normalizeString(typeof payload.text === "string" ? payload.text : null),
      offer_message_id:
        normalizePositiveInteger(payload.offer_message_id)
        ?? base.target_message_id
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
    const redeemed = await this.runRepositoryOperation(
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
      callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
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
    const redeemed = await this.runRepositoryOperation(
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
        text: config.TELEGRAM_UX_COPY_JSON.callbacks.scene_access_activated,
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

    return {
      ...base,
      operation: "noop",
      callback_valid: false,
      callback_answer_text: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
      callback_show_alert: false,
      payment_kind: "feature",
      payment_token: token,
      feature_key: "scene_unlock",
      reason: redeemed?.reason ?? "free_scene_unlock_invalid",
    };
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

    let invoiceToken: StoredInvoiceToken | null = null;
    let sceneUnlockInvoiceRows: StoredInvoiceToken[] = [];
    let tokenRowsInserted = 0;
    const shouldUpsertPhotoInvoice =
      decision.invoice_kind === "photo"
      && decision.invoice_sku
      && decision.invoice_amount
      && decision.original_invoice_amount
      && decision.invoice_title
      && decision.invoice_description
      && decision.invoice_label
      && decision.invoice_button_text
      && decision.invoice_payload_json
      && base.chat_id;
    const photoInvoiceInput = shouldUpsertPhotoInvoice
      ? buildPhotoInvoiceInput({
        chat_id: base.chat_id as number,
        scene_session_id: context.scene_session_id,
        turn_no: context.turn_no,
        scene_turn_no: context.scene_turn_no,
        media_signature: context.media_signature,
        target_message_id: context.target_message_id,
        current_uuid: decision.current_uuid,
        base_price_xtr: Number(context.base_price_xtr ?? 10),
        amount_xtr: decision.invoice_amount as number,
        original_amount_xtr: decision.original_invoice_amount as number,
        promo_key: decision.promo_key,
        invoice_sku: decision.invoice_sku as string,
        invoice_title: decision.invoice_title as string,
        invoice_description: decision.invoice_description as string,
        invoice_label: decision.invoice_label as string,
        invoice_button_text: decision.invoice_button_text as string,
        payload_json:
          decision.invoice_payload_json as NonNullable<typeof decision.invoice_payload_json>,
      })
      : null;
    const canOfferSceneUnlock =
      decision.invoice_kind === "photo"
      && context.subscription_active !== true
      && context.scene_access_active !== true
      && Boolean(context.scene_session_id)
      && Boolean(base.chat_id);
    const freeCredits = canOfferSceneUnlock && base.chat_id
      ? await this.repository.loadFreeCredits(base.chat_id as number)
      : null;
    const freeSceneUnlockButton =
      config.TELEGRAM_UX_COPY_JSON.free_actions?.scene_unlock_button;
    const freeSceneUnlockTokenRows =
      canOfferSceneUnlock
      && context.scene_session_id
      && base.chat_id
      && freeSceneUnlockButton
      && Math.max(0, Number(freeCredits?.free_scene_unlocks ?? 0)) > 0
        ? [
            buildFreeActionTokenRow({
              action_kind: "free_scene_unlock",
              chat_id: base.chat_id as number,
              scene_session_id: context.scene_session_id,
              turn_no: context.turn_no,
              scene_turn_no: context.scene_turn_no,
              media_signature: context.media_signature,
              target_message_id: context.target_message_id,
              current_uuid: decision.current_uuid,
              base_price_xtr: Number(context.base_price_xtr ?? 10),
              feature_key: "scene_unlock",
              action_button_text: freeSceneUnlockButton,
            }),
          ]
        : [];
    const sceneUnlockPlan =
      canOfferSceneUnlock
      && freeSceneUnlockTokenRows.length === 0
        ? resolveActionPlanByFeatureKey("scene_unlock")
        : null;
    const sceneUnlockInvoiceInput =
      sceneUnlockPlan && context.scene_session_id && base.chat_id
        ? buildSceneUnlockPaymentInputs({
          chat_id: base.chat_id as number,
          scene_session_id: context.scene_session_id,
          idempotency_key: `scene:${base.chat_id}:${context.scene_session_id}`,
          turn_limit: config.TURN_LIMIT,
          target_message_id: context.target_message_id,
          plan: sceneUnlockPlan,
        })
        : [];

    const allTokenRows = [...decision.token_rows, ...freeSceneUnlockTokenRows];

    if (allTokenRows.length > 0 && shouldUpsertPhotoInvoice) {
      const [insertedCount, storedInvoice] = await Promise.all([
        this.repository.upsertCallbackTokens(allTokenRows),
        this.repository.upsertInvoiceToken(photoInvoiceInput as NonNullable<typeof photoInvoiceInput>),
      ]);
      tokenRowsInserted = insertedCount;
      invoiceToken = storedInvoice;
    } else {
      tokenRowsInserted = allTokenRows.length > 0
        ? await this.repository.upsertCallbackTokens(allTokenRows)
        : 0;

      if (shouldUpsertPhotoInvoice) {
        invoiceToken = await this.repository.upsertInvoiceToken(
          photoInvoiceInput as NonNullable<typeof photoInvoiceInput>,
        );
      }
    }
    if (sceneUnlockInvoiceInput.length > 0) {
      sceneUnlockInvoiceRows = await this.repository.upsertInvoiceTokens(
        sceneUnlockInvoiceInput,
      );
    }
    const [linkedInvoiceToken, linkedSceneUnlockRows] = await Promise.all([
      invoiceToken
        ? this.ensureStoredPaymentReady(invoiceToken, "photo.nextPhoto")
        : Promise.resolve(null),
      sceneUnlockInvoiceRows.length > 0
        ? Promise.all(
          sceneUnlockInvoiceRows.map((row) =>
            this.ensureStoredPaymentReady(row, "photo.sceneUnlock")),
        )
        : Promise.resolve([]),
    ]);
    invoiceToken = linkedInvoiceToken;
    sceneUnlockInvoiceRows = linkedSceneUnlockRows;
    const sceneUnlockOfferItem = buildOfferItem(sceneUnlockInvoiceRows);
    const sceneUnlockRevealTokenRows =
      sceneUnlockOfferItem && sceneUnlockPlan
        ? [
            buildPaymentUiTokenRow({
              action_kind: "reveal_feature_payment_options",
              chat_id: context.chat_id,
              scene_session_id: context.scene_session_id,
              turn_no: context.turn_no,
              scene_turn_no: context.scene_turn_no,
              target_message_id: context.target_message_id,
              feature_key: "scene_unlock",
              action_button_text: sceneUnlockPlan.button_text,
              payment_options: sceneUnlockOfferItem.payment_options,
              idempotency_key: `scene-unlock-ui:${context.chat_id}:${context.scene_session_id ?? "no-scene"}`,
            }),
          ]
        : [];
    if (sceneUnlockRevealTokenRows.length > 0) {
      tokenRowsInserted += await this.repository.upsertCallbackTokens(
        sceneUnlockRevealTokenRows,
      );
    }

    return {
      ...base,
      operation: decision.operation,
      chat_id: context.chat_id,
      scene_session_id: context.scene_session_id,
      turn_no: context.turn_no,
      scene_turn_no: context.scene_turn_no,
      media_signature: context.media_signature,
      target_message_id: context.target_message_id,
      current_uuid: decision.current_uuid,
      photo_url: decision.photo_url,
      selected_uuid: decision.selected_uuid,
      token_rows: [...allTokenRows, ...sceneUnlockRevealTokenRows],
      token_rows_prepared: allTokenRows.length + sceneUnlockRevealTokenRows.length,
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
      ...buildTopLevelPaymentFields(invoiceToken ? [invoiceToken] : []),
      scene_unlock_offer_item: sceneUnlockOfferItem,
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
        precheckout_error: config.TELEGRAM_UX_COPY_JSON.payment_errors.stale,
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
    let validation = validatePrecheckout(
      tokenRow,
      normalizeString(input.payment_currency),
      normalizeNonNegativeInteger(input.payment_total_amount),
    );
    if (validation.ok && validation.action) {
      const payload = parseJsonObject(tokenRow?.payload_json) ?? {};
      const invoiceSceneSessionId =
        normalizeString(tokenRow?.scene_session_id)
        ?? normalizeString(
          typeof payload.scene_session_id === "string"
            ? payload.scene_session_id
            : null,
        );
      if (
        validation.action.payment_kind === "photo"
        || validation.action.feature_key === "scene_unlock"
      ) {
        const sceneStatus = await this.runRepositoryOperation(
          "payment.precheckout.loadSceneAccessStatus",
          {
            chat_id: chatId,
            payment_kind: validation.action.payment_kind,
            sku: normalizeString(tokenRow?.sku),
            invoice_status: normalizeString(tokenRow?.status),
          },
          () => this.repository.loadSceneAccessStatus({
            chat_id: chatId,
            scene_session_id: invoiceSceneSessionId,
          }),
        );
        if (!invoiceSceneSessionId || sceneStatus?.scene_is_active !== true) {
          validation = {
            ...validation,
            ok: false,
            error: config.TELEGRAM_UX_COPY_JSON.payment_errors.different_scene,
            reason: "scene_invoice_not_active",
          };
        } else if (sceneStatus.subscription_active) {
          validation = {
            ...validation,
            ok: false,
            error: config.TELEGRAM_UX_COPY_JSON.payment_errors.subscription_active,
            reason: "subscription_already_active",
          };
        } else if (sceneStatus.scene_access_active) {
          validation = {
            ...validation,
            ok: false,
            error: config.TELEGRAM_UX_COPY_JSON.payment_errors.scene_already_unlocked,
            reason: "scene_access_already_active",
          };
        }
      }
    }

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
    const inputPaymentSource = normalizePaymentSource(input.payment_source);
    if (
      inputPaymentSource === "sbp"
      || normalizeString(input.event_type) === "payment.confirmed.received"
    ) {
      return this.evaluateExternalPaymentSuccess(base, input);
    }

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
        loaded.amount ?? loaded.amount_xtr,
        loaded.currency ?? config.MEDIA_PAYMENT_CURRENCY,
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
      if (
        resolvedAction.payment_kind === "feature"
        && resolvedAction.feature_key === "scene_unlock"
      ) {
        return {
          ...base,
          operation: "scene_access_activated",
          text: config.TELEGRAM_UX_COPY_JSON.callbacks.scene_access_activated,
          chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
          scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
          turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
          payment_kind: resolvedAction.payment_kind,
          payment_token: loaded.token,
          feature_key: resolvedAction.feature_key,
          target_message_id:
            normalizePositiveInteger(payload.target_message_id)
            ?? normalizePositiveInteger(loaded.telegram_invoice_message_id)
            ?? null,
          reason: "already_active",
        };
      }
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
          payment_source: "stars",
          telegram_payment_charge_id: normalizeString(
            input.telegram_payment_charge_id,
          ),
          provider_payment_charge_id: normalizeString(
            input.provider_payment_charge_id,
          ),
          external_payment_id: null,
          payment_currency: normalizeString(input.payment_currency),
          payment_total_amount: normalizeNonNegativeInteger(
            input.payment_total_amount,
          ),
          checkout_url: normalizeString(input.checkout_url),
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
      if (resolvedAction.feature_key === "scene_unlock") {
        return this.fulfillSceneAccessPayment(
          base,
          paidRow,
          payload,
          resolvedAction,
        );
      }
      return this.buildFeatureFulfillmentResponse(
        base,
        paidRow,
        payload,
        resolvedAction,
      );
    }

    return this.fulfillPhotoPayment(base, paidRow, payload);
  }

  private async evaluateExternalPaymentSuccess(
    base: MediaCommerceDecisionResponse,
    input: MediaCommerceDecisionRequest,
  ): Promise<MediaCommerceDecisionResponse> {
    const externalPaymentId = normalizeString(input.external_payment_id);

    if (!externalPaymentId) {
      return {
        ...base,
        payment_source: "sbp",
        reason: "external_payment_id_required",
      };
    }

    const loaded = await this.runRepositoryOperation(
      "payment.external.loadInvoiceTokenByExternalPaymentId",
      {
        chat_id: null,
        payment_kind: null,
        sku: null,
        invoice_status: null,
      },
      () => this.repository.loadInvoiceTokenByExternalPaymentId(externalPaymentId),
    );
    if (!loaded?.found || !loaded.token) {
      return {
        ...base,
        payment_source: "sbp",
        reason: "payment_not_found",
      };
    }

    if (normalizeString(loaded.kind) !== INVOICE_PAYLOAD_KIND) {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_source: "sbp",
        reason: "invoice_kind_invalid",
      };
    }

    if (normalizePaymentSource(loaded.payment_source) !== "sbp") {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_source: normalizePaymentSource(loaded.payment_source),
        reason: "payment_source_invalid",
      };
    }

    const payload = parseJsonObject(loaded.payload_json) ?? {};
    const loadedToken = loaded.token;
    const loadedChatId = normalizePositiveInteger(loaded.chat_id);
    const actionResolution = resolveInvoiceActionResult(payload, loaded.action_kind);
    if (actionResolution.reason != null || !actionResolution.action) {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_source: "sbp",
        reason: actionResolution.reason ?? "invoice_action_kind_invalid",
      };
    }

    const resolvedAction = actionResolution.action;
    const existingStatus = normalizeString(loaded.status);
    if (
      !hasExpectedPaymentDetails(
        loaded.amount,
        loaded.currency ?? "RUB",
        normalizeString(input.payment_currency),
        normalizeNonNegativeInteger(input.payment_total_amount),
      )
    ) {
      return {
        ...base,
        chat_id: normalizePositiveInteger(loaded.chat_id) ?? base.chat_id,
        scene_session_id: loaded.scene_session_id ?? base.scene_session_id,
        turn_no: normalizeNonNegativeInteger(loaded.turn_no) ?? base.turn_no,
        payment_source: "sbp",
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
        payment_source: "sbp",
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
      paidRow = await this.runRepositoryOperation(
        "payment.external.markInvoicePaid",
        {
          chat_id: loadedChatId,
          payment_kind: resolvedAction.payment_kind,
          sku: normalizeString(loaded.sku),
          invoice_status: existingStatus,
        },
        () => this.repository.markInvoicePaid({
          token: loadedToken,
          chat_id: loadedChatId ?? 0,
          expected_kind: INVOICE_PAYLOAD_KIND,
          expected_action_kind: resolvedAction.action_kind,
          payment_source: "sbp",
          telegram_payment_charge_id: null,
          provider_payment_charge_id: null,
          external_payment_id: externalPaymentId,
          payment_currency: normalizeString(input.payment_currency),
          payment_total_amount: normalizeNonNegativeInteger(input.payment_total_amount),
          checkout_url: normalizeString(input.checkout_url),
        }),
      );

      if (!paidRow) {
        const reloaded = await this.runRepositoryOperation(
          "payment.external.reloadInvoiceTokenByExternalPaymentId",
          {
            chat_id: loadedChatId,
            payment_kind: resolvedAction.payment_kind,
            sku: normalizeString(loaded.sku),
            invoice_status: existingStatus,
          },
          () => this.repository.loadInvoiceTokenByExternalPaymentId(externalPaymentId),
        );
        const reloadedStatus = normalizeString(reloaded?.status);
        if (reloadedStatus === "fulfilled") {
          return {
            ...base,
            chat_id: normalizePositiveInteger(reloaded?.chat_id) ?? base.chat_id,
            scene_session_id: reloaded?.scene_session_id ?? base.scene_session_id,
            turn_no: normalizeNonNegativeInteger(reloaded?.turn_no) ?? base.turn_no,
            payment_source: "sbp",
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
        payment_source: "sbp",
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
        payment_source: "sbp",
        payment_kind: resolvedAction.payment_kind,
        feature_key: resolvedAction.feature_key,
        reason: "payment_not_claimed",
      };
    }

    if (resolvedAction.payment_kind === "subscription") {
      return this.fulfillSubscriptionPayment(base, paidRow, resolvedAction);
    }

    if (resolvedAction.payment_kind === "feature") {
      if (resolvedAction.feature_key === "scene_unlock") {
        return this.fulfillSceneAccessPayment(base, paidRow, payload, resolvedAction);
      }
      return this.buildFeatureFulfillmentResponse(base, paidRow, payload, resolvedAction);
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

  private async fulfillSceneAccessPayment(
    base: MediaCommerceDecisionResponse,
    paidRow: PaidInvoiceToken,
    payload: Record<string, unknown>,
    action: FeaturePaymentAction,
  ): Promise<MediaCommerceDecisionResponse> {
    const sceneSessionId = normalizeString(
      typeof payload.scene_session_id === "string"
        ? payload.scene_session_id
        : paidRow.scene_session_id,
    );
    const sceneAccessSku = normalizeString(paidRow.sku);
    if (!sceneSessionId || !sceneAccessSku) {
      return {
        ...base,
        chat_id: paidRow.chat_id,
        scene_session_id: paidRow.scene_session_id,
        turn_no: paidRow.turn_no,
        payment_kind: "feature",
        payment_token: paidRow.token,
        feature_key: action.feature_key,
        reason: "scene_access_invoice_invalid",
      };
    }

    const activatedCount = await this.runRepositoryOperation(
      "payment.sceneAccess.activateSceneAccess",
      {
        chat_id: paidRow.chat_id,
        payment_kind: "feature",
        sku: sceneAccessSku,
        invoice_status: paidRow.status,
      },
      () => this.repository.activateSceneAccess({
        payment_token: paidRow.token,
        chat_id: paidRow.chat_id,
        scene_session_id: sceneSessionId,
        scene_access_sku: sceneAccessSku,
      }),
    );
    const failureReason = activatedCount > 0
      ? null
      : await this.resolveSceneAccessActivationFailure(
        paidRow.chat_id,
        sceneSessionId,
      );

    return {
      ...base,
      operation: activatedCount > 0 ? "scene_access_activated" : "noop",
      text: activatedCount > 0
        ? config.TELEGRAM_UX_COPY_JSON.callbacks.scene_access_activated
        : undefined,
      chat_id:
        normalizePositiveInteger(payload.chat_id)
        ?? paidRow.chat_id,
      scene_session_id: sceneSessionId,
      turn_no:
        normalizeNonNegativeInteger(payload.turn_no)
        ?? normalizeNonNegativeInteger(paidRow.turn_no),
      scene_turn_no: normalizeNonNegativeInteger(payload.scene_turn_no),
      target_message_id:
        normalizePositiveInteger(payload.target_message_id)
        ?? normalizePositiveInteger(paidRow.telegram_invoice_message_id)
        ?? null,
      payment_kind: "feature",
      payment_token: paidRow.token,
      feature_key: action.feature_key,
      stored_count: activatedCount,
      reason:
        activatedCount > 0
          ? "scene_access_activated"
          : failureReason,
    };
  }

  private async resolveSceneAccessActivationFailure(
    chatId: number,
    sceneSessionId: string,
  ): Promise<"already_active" | "scene_not_active" | "invoice_invalid"> {
    const sceneStatus = await this.runRepositoryOperation(
      "payment.sceneAccess.loadSceneAccessStatus",
      {
        chat_id: chatId,
        payment_kind: "feature",
        sku: "payment_action_2",
        invoice_status: "paid",
      },
      () => this.repository.loadSceneAccessStatus({
        chat_id: chatId,
        scene_session_id: sceneSessionId,
      }),
    );
    if (sceneStatus?.scene_is_active !== true) {
      return "scene_not_active";
    }
    if (sceneStatus.scene_access_active) {
      return "already_active";
    }
    return "invoice_invalid";
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

  private async resolveAbTestSelection(
    chatId: number,
    key: "subscription_offer",
  ): Promise<AbTestSelection | null> {
    const experiment = findActiveExperiment(config.EXPERIMENTS, key);
    if (!experiment) {
      return null;
    }

    const buildSelection = (
      assignment: NonNullable<ReturnType<typeof parseAbTestAssignment>>,
    ): AbTestSelection | null => {
      const params = experiment.variants[assignment.variant];
      if (!params) {
        console.error("[media_commerce] ab_test_variant_missing", {
          chat_id: chatId,
          key,
          starts_at: experiment.starts_at,
          version: experiment.version,
          variant: assignment.variant,
        });
        return null;
      }

      return {
        assignment_key: experiment.assignment_key,
        config: experiment,
        assignment,
        params,
      };
    };

    const existingAssignment = parseAbTestAssignment(
      await this.repository.loadAbTestAssignment(
        chatId,
        experiment.assignment_key,
      ),
    );
    if (existingAssignment) {
      return buildSelection(existingAssignment);
    }

    const assignment = buildAssignment({
      variant: chooseVariant(experiment.distribution),
    });
    const storedAssignment = parseAbTestAssignment(
      await this.repository.storeAbTestAssignment(
        chatId,
        experiment.assignment_key,
        assignment,
      ),
    ) ?? assignment;

    return buildSelection(storedAssignment);
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
    const abSelection = await this.resolveAbTestSelection(
      chatId,
      "subscription_offer",
    );
    const abContext = toAbTestContext(abSelection);
    const abParams = abSelection?.params ?? {};
    const abTokenSuffix = buildAbTokenSuffix(abSelection);
    const effectiveIdempotencyKey =
      abTokenSuffix != null
        ? `${idempotencyKey}:ab_${abTokenSuffix}`
        : idempotencyKey;
    const offerText = resolveSubscriptionOfferText(
      abParams,
      subscriptionOfferReason,
    );
    const [offerAccessStatus, freeCredits] = await Promise.all([
      this.runRepositoryOperation(
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
      ),
      this.repository.loadFreeCredits(chatId),
    ]);
    const subscriptionActive = offerAccessStatus?.subscription_active === true;
    const sceneAccessActive = offerAccessStatus?.scene_access_active === true;
    const activeSceneSessionId =
      normalizeString(offerAccessStatus?.active_scene_session_id)
      ?? normalizeString(freeCredits?.active_scene_session_id)
      ?? null;
    const freeSceneUnlockButton =
      config.TELEGRAM_UX_COPY_JSON.free_actions?.scene_unlock_button;
    const freeSceneUnlockTokenRows =
      !subscriptionActive
      && !sceneAccessActive
      && activeSceneSessionId
      && abParams.scene_unlock?.enabled !== false
      && freeSceneUnlockButton
      && Math.max(0, Number(freeCredits?.free_scene_unlocks ?? 0)) > 0
        ? [
            buildFreeActionTokenRow({
              action_kind: "free_scene_unlock",
              chat_id: chatId,
              scene_session_id: activeSceneSessionId,
              turn_no: null,
              scene_turn_no: null,
              target_message_id: null,
              feature_key: "scene_unlock",
              action_button_text: freeSceneUnlockButton,
              ab_test: abContext,
            }),
          ]
        : [];
    const sceneUnlockPlan =
      !subscriptionActive
      && !sceneAccessActive
      && activeSceneSessionId
      && freeSceneUnlockTokenRows.length === 0
        ? applySceneUnlockOverride(
          resolveActionPlanByFeatureKey("scene_unlock"),
          abParams,
        )
        : null;
    const subscriptionPlans = applySubscriptionPlanOverrides(
      resolveSubscriptionPlans(),
      abParams,
    );
    const invoiceInputs = [
      ...(sceneUnlockPlan && activeSceneSessionId
        ? buildSceneUnlockPaymentInputs({
          chat_id: chatId,
          scene_session_id: activeSceneSessionId,
          idempotency_key: effectiveIdempotencyKey,
          subscription_offer_reason: subscriptionOfferReason,
          turn_limit: turnLimit,
          turns_today: turnsToday,
          turn_limit_reset_text: turnLimitResetText,
          plan: sceneUnlockPlan,
          ab_test: abContext,
        })
        : []),
      ...subscriptionPlans.flatMap((plan, index) =>
        buildSubscriptionPaymentInputs({
          chat_id: chatId,
          idempotency_key: effectiveIdempotencyKey,
          subscription_offer_reason: subscriptionOfferReason,
          turn_limit: turnLimit,
          turns_today: turnsToday,
          turn_limit_reset_text: turnLimitResetText,
          sort_order: index + 1,
          plan,
          ab_test: abContext,
        })),
    ];

    const upsertedRows = await this.repository.upsertInvoiceTokens(
      invoiceInputs,
    );
    const tokenList = upsertedRows.map((row) => row.token);
    const rows = await Promise.all(
      upsertedRows.map((row) =>
        this.ensureStoredPaymentReady(row, "subscription")),
      );

    const sortedRows = rows
      .slice()
      .sort(
        (left, right) =>
          Number(left.payload_json.sort_order ?? 100)
          - Number(right.payload_json.sort_order ?? 100)
          || Number(left.payload_json.subscription_days ?? 0)
          - Number(right.payload_json.subscription_days ?? 0)
          || getSourceSortOrder(normalizePaymentSource(left.payment_source))
          - getSourceSortOrder(normalizePaymentSource(right.payment_source)),
      );
    const subscriptionOfferItems = groupOfferItems(sortedRows);
    const sceneUnlockOfferItem =
      subscriptionOfferItems.find((item) => item.feature_key === "scene_unlock")
      ?? null;
    const paidSceneUnlockRevealTokenRows =
      sceneUnlockOfferItem != null
        ? [
            buildPaymentUiTokenRow({
              action_kind: "reveal_feature_payment_options",
              chat_id: chatId,
              scene_session_id: activeSceneSessionId,
              turn_no: null,
              scene_turn_no: null,
              target_message_id: null,
              feature_key: "scene_unlock",
              action_button_text: sceneUnlockPlan?.button_text ?? sceneUnlockOfferItem.label,
              payment_options: sceneUnlockOfferItem.payment_options,
              idempotency_key: `subscription-scene-unlock-ui:${effectiveIdempotencyKey}:${activeSceneSessionId ?? "no-scene"}`,
            }),
          ]
        : [];
    const hasSbpSubscriptionOption = subscriptionOfferItems.some((item) =>
      item.payment_kind === "subscription"
      && item.payment_options.some((option) => option.source === "sbp"));
    const hasStarsSubscriptionOption = subscriptionOfferItems.some((item) =>
      item.payment_kind === "subscription"
      && item.payment_options.some((option) => option.source === "stars"));
    const defaultPaymentSource: PaymentSource =
      hasSbpSubscriptionOption ? "sbp" : "stars";
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
              subscription_offer_items: subscriptionOfferItems,
              token_rows: [
                ...freeSceneUnlockTokenRows,
                ...paidSceneUnlockRevealTokenRows,
              ],
              text: offerText,
              offer_message_id: offerMessageId,
              selected_payment_source: source,
              idempotency_key: `subscription-source-ui:${effectiveIdempotencyKey}`,
              ab_test: abContext,
            }))
        : [];
    const paymentSourceToggleTokens = buildPaymentSourceToggleTokenMap(
      subscriptionPaymentToggleTokenRows,
    );
    const tokenRows = [
      ...freeSceneUnlockTokenRows,
      ...paidSceneUnlockRevealTokenRows,
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
      ? await this.runRepositoryOperation(
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
