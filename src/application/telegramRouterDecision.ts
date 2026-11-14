import { config } from "../config.js";
import { ChatAccessRepository } from "./chatAccessRepository.js";
import { prependFreeBalances } from "../freeBalanceFormatter.js";
import { isMaintenanceBlocked } from "../maintenance.js";
import { normalizeNonNegativeInteger, normalizePositiveInteger } from "../numeric.js";
import type { LocalizationService } from "../localization.js";
import { parseTelegramLanguage, type TelegramLanguage } from "../telegramLanguage.js";
import type { TelegramUxCopy } from "../config.js";
import type {
  NavigationRegistration,
  TelegramNavigationScreen,
} from "../telegramNavigationRepository.js";
import type {
  AccessContext,
  AccessDecisionRequest,
  AccessDecisionResponse,
  RouterAction,
  RouterDomain,
  RouterIntent,
} from "../types.js";
import { calculateFullUpgrade, resolveSubscriptionPlans } from "../modules/products/plans.js";

const START_COMMAND = "/start";
const MENU_COMMAND = "/menu";
const SUBSCRIPTION_COMMAND = "/subscription";
const PAYSUPPORT_COMMAND = "/paysupport";
const LANGUAGE_COMMAND = "/language";

function hasAvailableFullUpgrade(context: AccessContext): boolean {
  if (!config.MEDIA_VIDEO_ENABLED || context.video_pass_active) return false;
  const nominal = config.MEDIA_SUBSCRIPTION_PLANS_JSON.find(
    (plan) => plan.sku === context.subscription_sku,
  );
  if (!nominal || nominal.tier === "full") return false;
  return resolveSubscriptionPlans()
    .filter((plan) => plan.tier === "full")
    .some((plan) => {
      const quote = calculateFullUpgrade(
        plan,
        nominal,
        config.MEDIA_UPGRADE_DISCOUNT_PERCENT,
      );
      return quote.amount_xtr > 0
        || (config.SBP_ENABLED && quote.amount_rub != null && quote.amount_rub > 0);
    });
}

const ACCESS_CONTEXT_INTENTS = new Set<RouterIntent>([
  "scene_start",
  "menu",
  "subscription",
  "paysupport",
  "language",
  "language_select",
  "terms_accept",
  "newscene_confirm",
  "character_select",
  "scene_mode",
  "scene_message",
]);

type RouterClassification = {
  domain: RouterDomain;
  intent: RouterIntent;
  action: RouterAction;
  character_i?: number | null;
  gallery_page?: number | null;
  scene_mode?: string | null;
  reward_slot?: number | null;
  post_accept_intent?: "start" | "menu" | "subscription" | "paysupport" | null;
  newscene_action?: "yes" | "no" | null;
  expected_scene_session_id?: string | null;
  newscene_callback_bound?: boolean;
  selected_language?: TelegramLanguage | null;
};

type AccessRepository = Pick<
  ChatAccessRepository,
  | "ensureAndLoadAccessContext"
  | "admitMessage"
  | "setTelegramLanguage"
  | "registerTelegramNavigation"
  | "resumeTelegramNavigation"
  | "observeTelegramUpdate"
  | "popActiveSubscriptionOffer"
> & Partial<Pick<ChatAccessRepository, "resolveTelegramLanguage">>;

type LocalizationReader = Pick<
  LocalizationService,
  "getTelegramCopy" | "getEnabledLanguages" | "isEnabledLanguage"
>;

function isAllowedClassification(classification: RouterClassification): boolean {
  switch (classification.intent) {
    case "scene_start":
    case "menu":
    case "subscription":
    case "paysupport":
    case "language":
    case "language_select":
    case "terms_accept":
    case "reward_claim":
    case "newscene_confirm":
    case "character_page":
    case "character_select":
    case "character_back":
    case "scene_mode":
    case "commerce_callback":
    case "interaction_event":
    case "reachability_update":
    case "scene_message":
      return true;
    case "unknown_command":
    case "noop":
      return false;
  }
}

function normalizeCommand(command: string | null | undefined): string | null {
  if (!command) return null;
  const normalized = command.trim().toLowerCase();
  return normalized || null;
}

function normalizeCallbackData(callbackData: string | null | undefined): string | null {
  if (!callbackData) return null;
  const normalized = callbackData.trim();
  return normalized || null;
}

function normalizeSource(source: string | null | undefined): string {
  const normalized = String(source ?? "").trim();
  return normalized || "telegram";
}

function buildIdempotencyKey(
  source: string,
  updateId: number | null | undefined,
): string | null {
  return updateId != null ? `${source}:${updateId}` : null;
}

function resolvePostAcceptIntent(
  classification: RouterClassification,
): "start" | "menu" | "subscription" | "paysupport" {
  if (classification.intent === "subscription") return "subscription";
  if (classification.intent === "paysupport") return "paysupport";
  if (classification.intent === "menu" || classification.intent === "scene_mode") {
    return "menu";
  }
  return "start";
}

function requiresAccessContext(classification: RouterClassification): boolean {
  return ACCESS_CONTEXT_INTENTS.has(classification.intent);
}

function shouldRegisterNavigation(
  source: string,
  input: AccessDecisionRequest,
  classification: RouterClassification,
): boolean {
  if (source !== "telegram" || normalizePositiveInteger(input.update_id) == null) {
    return false;
  }

  return ![
    "commerce_callback",
    "interaction_event",
    "reachability_update",
    "noop",
  ].includes(classification.intent);
}

function expectedMenuScreen(
  classification: RouterClassification,
): TelegramNavigationScreen | null {
  if (
    classification.intent === "character_select"
    || classification.intent === "character_page"
  ) {
    return "character_gallery";
  }
  if (
    classification.intent === "character_back"
    || classification.intent === "scene_mode"
  ) {
    return "character_mode";
  }
  return null;
}

function requiresTermsGate(classification: RouterClassification): boolean {
  return ACCESS_CONTEXT_INTENTS.has(classification.intent)
    && classification.intent !== "language"
    && classification.intent !== "language_select"
    && classification.intent !== "terms_accept";
}

function requiresSceneAccessCheck(classification: RouterClassification): boolean {
  return classification.intent === "scene_message";
}

function isMaintenanceUserAction(
  input: AccessDecisionRequest,
  classification: RouterClassification,
): boolean {
  const eventType = String(input.event_type ?? "").trim();
  if (
    eventType === "my_chat_member.updated"
    || eventType === "payment.pre_checkout.received"
    || eventType === "payment.success.received"
    || eventType === "payment.confirmed.received"
    || eventType === "payment.canceled.received"
    || eventType === "payment.chargebacked.received"
  ) {
    return false;
  }

  return classification.domain === "command"
    || classification.domain === "scene"
    || classification.domain === "interaction";
}

function shouldDismissSubscriptionOffer(classification: RouterClassification): boolean {
  if (
    classification.action === "handle_commerce_interaction" ||
    classification.action === "update_reachability_state" ||
    classification.action === "ignore"
  ) {
    return false;
  }

  return classification.intent !== "interaction_event"
    && classification.intent !== "commerce_callback"
    && classification.intent !== "language"
    && classification.intent !== "language_select"
    && classification.intent !== "reachability_update"
    && classification.intent !== "unknown_command"
    && classification.intent !== "noop";
}

function ignoreStructuredCallback(): RouterClassification {
  return {
    domain: "interaction",
    intent: "interaction_event",
    action: "ignore",
  };
}

function parseStructuredCallback(
  callbackData: string,
): RouterClassification | null {
  const parts = callbackData.split(":");
  const namespace = parts[0];

  switch (namespace) {
    case "language_select": {
      if (parts.length !== 2) return ignoreStructuredCallback();
      const language = parseTelegramLanguage(parts[1]);
      if (language == null) return ignoreStructuredCallback();
      return {
        domain: "interaction",
        intent: "language_select",
        action: "acknowledge_language_change",
        selected_language: language,
      };
    }
    case "reward_claim": {
      if (parts.length !== 2) return ignoreStructuredCallback();
      const rewardSlot = normalizePositiveInteger(parts[1]);
      if (rewardSlot == null) return ignoreStructuredCallback();
      return {
        domain: "interaction",
        intent: "reward_claim",
        action: "handle_reward_claim",
        reward_slot: rewardSlot,
      };
    }
    case "terms_accept": {
      if (
        parts.length !== 2 ||
        !["start", "menu", "subscription", "paysupport"].includes(parts[1] ?? "")
      ) {
        return ignoreStructuredCallback();
      }
      return {
        domain: "interaction",
        intent: "terms_accept",
        action: "handle_terms_accept",
        post_accept_intent: parts[1] as "start" | "menu" | "subscription" | "paysupport",
      };
    }
    case "newscene_confirm": {
      if (
        (parts.length !== 2 && parts.length !== 4)
        || !["yes", "no"].includes(parts[1] ?? "")
      ) {
        return ignoreStructuredCallback();
      }

      const characterId = parts.length === 4
        ? normalizePositiveInteger(parts[2])
        : null;
      const expectedSceneSessionId = parts.length === 4
        ? String(parts[3] ?? "").trim()
        : null;
      if (
        parts.length === 4
        && (
          characterId == null
          || !expectedSceneSessionId
          || expectedSceneSessionId.includes(":")
        )
      ) {
        return ignoreStructuredCallback();
      }

      return {
        domain: "interaction",
        intent: "newscene_confirm",
        action: "handle_newscene_confirm",
        newscene_action: parts[1] as "yes" | "no",
        character_i: characterId,
        expected_scene_session_id: expectedSceneSessionId,
        newscene_callback_bound: parts.length === 4,
      };
    }
    case "character_select": {
      if (parts.length !== 2 && parts.length !== 3) return ignoreStructuredCallback();
      const characterId = normalizePositiveInteger(parts[1]);
      const galleryPage = parts.length === 3
        ? normalizePositiveInteger(parts[2])
        : 1;
      if (characterId == null || galleryPage == null) return ignoreStructuredCallback();
      return {
        domain: "interaction",
        intent: "character_select",
        action: "show_character_mode_screen",
        character_i: characterId,
        gallery_page: galleryPage,
      };
    }
    case "character_page": {
      if (parts.length !== 2) return ignoreStructuredCallback();
      const galleryPage = normalizePositiveInteger(parts[1]);
      if (galleryPage == null) return ignoreStructuredCallback();
      return {
        domain: "interaction",
        intent: "character_page",
        action: "show_character_gallery",
        gallery_page: galleryPage,
      };
    }
    case "character_menu": {
      if ((parts.length !== 2 && parts.length !== 3) || parts[1] !== "back") {
        return ignoreStructuredCallback();
      }
      const galleryPage = parts.length === 3
        ? normalizePositiveInteger(parts[2])
        : 1;
      if (galleryPage == null) return ignoreStructuredCallback();
      return {
        domain: "interaction",
        intent: "character_back",
        action: "handle_character_back",
        gallery_page: galleryPage,
      };
    }
    case "scene_mode": {
      if (parts.length !== 2 && parts.length !== 3) return ignoreStructuredCallback();
      const sceneMode = parts[1];
      if (sceneMode !== "fast" && sceneMode !== "roleplay") {
        return ignoreStructuredCallback();
      }

      const characterId = parts.length === 3
        ? normalizePositiveInteger(parts[2])
        : null;
      if (parts.length === 3 && characterId == null) {
        return ignoreStructuredCallback();
      }

      return {
        domain: "interaction",
        intent: "scene_mode",
        action: "handle_scene_mode",
        scene_mode: sceneMode,
        character_i: characterId,
      };
    }
    default:
      return null;
  }
}

function classifyRouterInput(input: AccessDecisionRequest): RouterClassification {
  const command = normalizeCommand(input.command);
  const routeTarget = String(input.route_target ?? "").trim();
  const eventType = String(input.event_type ?? "").trim();
  const callbackData = normalizeCallbackData(input.callback_data);

  if (callbackData) {
    const structuredCallback = parseStructuredCallback(callbackData);
    if (structuredCallback) return structuredCallback;
  }

  if (eventType === "callback_query.received") {
    return {
      domain: "interaction",
      intent: "commerce_callback",
      action: "handle_commerce_interaction",
    };
  }

  if (command === START_COMMAND) {
    return {
      domain: "command",
      intent: "scene_start",
      action: "show_character_gallery",
    };
  }

  if (command === MENU_COMMAND) {
    return {
      domain: "command",
      intent: "menu",
      action: "show_character_gallery",
    };
  }

  if (command === SUBSCRIPTION_COMMAND) {
    return {
      domain: "command",
      intent: "subscription",
      action: "show_subscription_offer",
    };
  }

  if (command === PAYSUPPORT_COMMAND) {
    return {
      domain: "command",
      intent: "paysupport",
      action: "send_paysupport_message",
    };
  }

  if (command === LANGUAGE_COMMAND) {
    return {
      domain: "command",
      intent: "language",
      action: "show_language_selector",
    };
  }

  if (command) {
    return {
      domain: "command",
      intent: "unknown_command",
      action: "ignore",
    };
  }

  if (
    eventType === "payment.pre_checkout.received" ||
    eventType === "payment.success.received"
  ) {
    return {
      domain: "interaction",
      intent: "interaction_event",
      action: "handle_commerce_interaction",
    };
  }

  if (eventType === "my_chat_member.updated") {
    return {
      domain: "reachability",
      intent: "reachability_update",
      action: "update_reachability_state",
    };
  }

  if (
    eventType === "message.text.received" ||
    eventType === "message.caption.received"
  ) {
    return {
      domain: "scene",
      intent: "scene_message",
      action: "run_scene_core",
    };
  }

  if (routeTarget === "interaction") {
    return {
      domain: "interaction",
      intent: "interaction_event",
      action: "handle_commerce_interaction",
    };
  }

  if (routeTarget === "reachability") {
    return {
      domain: "reachability",
      intent: "reachability_update",
      action: "update_reachability_state",
    };
  }

  if (routeTarget === "scene_core") {
    return {
      domain: "scene",
      intent: "scene_message",
      action: "run_scene_core",
    };
  }

  return {
    domain: "noop",
    intent: "noop",
    action: "ignore",
  };
}

function formatSubscriptionStatusText(
  context: AccessContext,
  copy: TelegramUxCopy,
): string {
  const text = copy.subscription.active
    .replaceAll("{subscription_sku}", String(context.subscription_sku ?? ""))
    .replaceAll("{subscription_until}", String(context.subscription_until ?? ""))
    .replaceAll(
      "{subscription_days}",
      String(
        config.MEDIA_SUBSCRIPTION_PLANS_JSON.find(
          (item) => item.sku === context.subscription_sku,
        )?.days ?? "",
      ),
    );
  return prependFreeBalances(text, context, copy.free_balances) ?? text;
}

function replaceCount(template: string, count: number): string {
  return template.replaceAll("{count}", String(count));
}

function formatPaysupportText(
  context: AccessContext,
  uxCopy: TelegramUxCopy,
): string {
  const copy = uxCopy.paysupport;
  const lines = [copy.message_html];
  const fastSkips = normalizeNonNegativeInteger(context.free_fast_scene_skips) ?? 0;
  const sceneUnlocks = normalizeNonNegativeInteger(context.free_scene_unlocks) ?? 0;

  if (fastSkips > 0 && copy.free_fast_scene_skips_line) {
    lines.push(replaceCount(copy.free_fast_scene_skips_line, fastSkips));
  }
  if (sceneUnlocks > 0 && copy.free_scene_unlocks_line) {
    lines.push(replaceCount(copy.free_scene_unlocks_line, sceneUnlocks));
  }

  return lines.join("\n");
}

function legalUrl(
  locale: string,
  kind: "terms" | "privacy",
): string | null {
  return config.LEGAL_URLS_JSON[locale]?.[kind]
    ?? config.LEGAL_URLS_JSON.ru?.[kind]
    ?? (kind === "terms" ? config.PUBLIC_OFFER_URL : null);
}

export class AccessDecisionService {
  constructor(
    private readonly repository: AccessRepository,
    private readonly localization: LocalizationReader,
  ) {}

  async evaluate(
    input: AccessDecisionRequest,
  ): Promise<AccessDecisionResponse> {
    const classification = classifyRouterInput(input);
    const source = normalizeSource(input.source);
    const sourceUserId = normalizePositiveInteger(input.source_user_id);
    const shouldResolvePassthroughLanguage = !requiresAccessContext(classification)
      || (
        isMaintenanceUserAction(input, classification)
        && isMaintenanceBlocked(input.source_user_id)
      );
    const passthroughLanguage = shouldResolvePassthroughLanguage
      && sourceUserId != null
      && this.repository.resolveTelegramLanguage
      ? await this.repository.resolveTelegramLanguage(sourceUserId)
      : null;
    const defaultUxCopy = await this.localization.getTelegramCopy(passthroughLanguage ?? "ru");
    const idempotencyKey = buildIdempotencyKey(source, input.update_id);
    const effectiveCharacterId =
      classification.character_i ?? input.character_i ?? null;
    const effectiveSceneMode = classification.scene_mode ?? input.scene_mode ?? null;
    let navigation: NavigationRegistration | null = null;
    const continuationRevision = normalizePositiveInteger(
      input.continuation_navigation_revision,
    );
    if (
      source === "telegram"
      && continuationRevision != null
      && normalizePositiveInteger(input.update_id) != null
    ) {
      navigation = await this.repository.resumeTelegramNavigation({
        chatId: input.chat_id,
        updateId: normalizePositiveInteger(input.update_id)!,
        navigationRevision: continuationRevision,
      });
    } else if (shouldRegisterNavigation(source, input, classification)) {
      navigation = await this.repository.registerTelegramNavigation({
        chatId: input.chat_id,
        updateId: normalizePositiveInteger(input.update_id)!,
        source,
        sourceUserId,
        expectedMenuScreen: expectedMenuScreen(classification),
        inboundMessageId: normalizePositiveInteger(input.inbound_message_id),
      });
    } else if (source === "telegram" && normalizePositiveInteger(input.update_id) != null) {
      await this.repository.observeTelegramUpdate();
    }
    const attachDismissedSubscriptionOffer = async <T extends AccessDecisionResponse>(
      response: T,
    ): Promise<T> => {
      if (!shouldDismissSubscriptionOffer(classification)) {
        return response;
      }

      const currentOfferId = response.action === "show_subscription_offer"
        ? idempotencyKey
        : null;
      const dismissedMessageId = await this.repository.popActiveSubscriptionOffer(
        response.chat_id,
        currentOfferId,
      );

      return dismissedMessageId
        ? {
          ...response,
          dismiss_subscription_offer_message_id: dismissedMessageId,
        }
        : response;
    };

    const passthrough = {
      domain: classification.domain,
      intent: classification.intent,
      action: classification.action,
      chat_id: input.chat_id,
      telegram_chat_id: input.chat_id,
      source,
      update_id: input.update_id ?? null,
      idempotency_key: idempotencyKey,
      source_user_id: input.source_user_id ?? null,
      command: input.command ?? null,
      event_type: input.event_type ?? null,
      route_target: input.route_target ?? null,
      message_type: input.message_type ?? null,
      user_message: input.user_message ?? null,
      raw_update: input.raw_update ?? null,
      inbound_message_id: input.inbound_message_id ?? null,
      callback_data: input.callback_data ?? null,
      callback_query_id: input.callback_query_id ?? null,
      panel_text: input.panel_text ?? null,
      panel_entities_json: input.panel_entities_json ?? null,
      pre_checkout_query_id: input.pre_checkout_query_id ?? null,
      invoice_payload: input.invoice_payload ?? null,
      telegram_payment_charge_id: input.telegram_payment_charge_id ?? null,
      provider_payment_charge_id: input.provider_payment_charge_id ?? null,
      payment_currency: input.payment_currency ?? null,
      payment_total_amount: input.payment_total_amount ?? null,
      reachability_status: input.reachability_status ?? null,
      telegram_chat_status: input.telegram_chat_status ?? null,
      character_i: effectiveCharacterId,
      gallery_page: classification.gallery_page ?? null,
      scene_mode: effectiveSceneMode,
      reward_slot: classification.reward_slot ?? null,
      post_accept_intent: classification.post_accept_intent ?? null,
      newscene_action: classification.newscene_action ?? null,
      expected_scene_session_id:
        classification.expected_scene_session_id ?? null,
      ux_copy: defaultUxCopy,
      language: passthroughLanguage,
      navigation_revision: navigation?.navigation_revision ?? null,
      navigation_status: navigation?.reason ?? null,
    } as const;

    if (navigation && !navigation.accepted) {
      return {
        ...passthrough,
        decision: "noop",
        action: "ignore",
        allowed: false,
        reason: `navigation_${navigation.reason}`,
      };
    }

    if (
      isMaintenanceUserAction(input, classification)
      && isMaintenanceBlocked(input.source_user_id)
    ) {
      return {
        ...passthrough,
        decision: "noop",
        action: "show_maintenance",
        allowed: false,
        text: defaultUxCopy.maintenance?.message ?? config.MAINTENANCE_TEXT,
        reason: "maintenance_mode",
      };
    }

    if (!requiresAccessContext(classification)) {
      return attachDismissedSubscriptionOffer({
        ...passthrough,
        decision: "noop",
        allowed: isAllowedClassification(classification),
        reason: classification.intent,
      });
    }

    const accessContext = await this.repository.ensureAndLoadAccessContext(
      input.chat_id,
      source,
      input.source_user_id ?? null,
      config.BUSINESS_TIME_ZONE,
      effectiveCharacterId,
      false,
    );

    let language = accessContext.language;
    let languageConfirmedAt = accessContext.language_confirmed_at;
    if (classification.intent === "language_select") {
      if (sourceUserId == null || classification.selected_language == null) {
        return attachDismissedSubscriptionOffer({
          ...passthrough,
          decision: "noop",
          action: "ignore",
          allowed: false,
          reason: "language_selection_invalid",
        });
      }
      const enabled = await this.localization.isEnabledLanguage(classification.selected_language);
      if (!enabled) {
        return attachDismissedSubscriptionOffer({
          ...passthrough,
          decision: "noop",
          action: "ignore",
          allowed: false,
          reason: "language_selection_invalid",
        });
      }
      languageConfirmedAt = await this.repository.setTelegramLanguage(
        sourceUserId,
        classification.selected_language,
        input.chat_id,
        navigation?.navigation_revision ?? null,
      );
      if (languageConfirmedAt == null) {
        return {
          ...passthrough,
          decision: "noop",
          action: "ignore",
          allowed: false,
          reason: "navigation_stale_before_language_update",
        };
      }
      language = classification.selected_language;
    }
    const resolvedLanguage: TelegramLanguage = language ?? "ru";
    const uxCopy = await this.localization.getTelegramCopy(resolvedLanguage);
    const languageOptions = (await this.localization.getEnabledLanguages())
      .map(({ locale, display_name }) => ({ locale, display_name }));

    const resolvedPassthrough = {
      ...passthrough,
      chat_id: accessContext.chat_id,
      telegram_chat_id: accessContext.telegram_chat_id,
      character_i: effectiveCharacterId ?? accessContext.character_i,
      language,
      language_confirmed_at: languageConfirmedAt,
      ux_copy: uxCopy,
    } as const;

    const hasSceneSession = Boolean(accessContext.active_scene_session_id);
    const hasStartedScene = accessContext.active_scene_exists;
    const contextFields = {
      language,
      language_confirmed_at: languageConfirmedAt,
      terms_accepted_at: accessContext.terms_accepted_at,
      subscription_active: accessContext.subscription_active,
      subscription_sku: accessContext.subscription_sku,
      subscription_until: accessContext.subscription_until,
      scene_session_id: hasSceneSession ? accessContext.active_scene_session_id : null,
      active_scene_session_id: accessContext.active_scene_session_id,
      has_started_scene: hasStartedScene,
      scene_turn_no:
        hasSceneSession && accessContext.scene_turn_no >= 0
          ? accessContext.scene_turn_no
          : null,
      scene_access_active: accessContext.scene_access_active,
      free_fast_scene_skips: accessContext.free_fast_scene_skips,
      free_scene_unlocks: accessContext.free_scene_unlocks,
      free_photo_unlocks: accessContext.free_photo_unlocks,
      free_video_unlocks: accessContext.free_video_unlocks,
      free_video_passes: accessContext.free_video_passes,
      turns_today: accessContext.turns_today,
      turn_limit: config.DAILY_FREE_LIMITS_JSON.messages,
      daily_photo_limit: config.DAILY_FREE_LIMITS_JSON.photos,
      turn_limit_reset_text: config.TURN_LIMIT_RESET_TEXT,
      selected_character_i: accessContext.selected_character_i,
      active_menu_screen: accessContext.active_menu_screen,
      active_menu_message_id: accessContext.active_menu_message_id,
      newscene_callback_valid: classification.intent === "newscene_confirm"
        ? classification.newscene_callback_bound === true
          && effectiveCharacterId != null
          && effectiveCharacterId === accessContext.character_i
          && effectiveCharacterId === accessContext.selected_character_i
          && accessContext.active_scene_exists
          && classification.expected_scene_session_id != null
          && classification.expected_scene_session_id
            === accessContext.active_scene_session_id
        : null,
    } as const;

    if (classification.intent === "language") {
      return attachDismissedSubscriptionOffer({
        ...resolvedPassthrough,
        ...contextFields,
        decision: "show_language_selector",
        action: "show_language_selector",
        language_options: languageOptions,
        allowed: true,
        reason: "language_command",
      });
    }

    if (classification.intent === "language_select") {
      if (accessContext.terms_accepted_at == null) {
        return attachDismissedSubscriptionOffer({
          ...resolvedPassthrough,
          ...contextFields,
          decision: "show_terms_gate",
          action: "show_terms_gate",
          allowed: false,
          post_accept_intent: "start",
          terms_offer_url: legalUrl(resolvedLanguage, "terms"),
          privacy_policy_url: legalUrl(resolvedLanguage, "privacy"),
          reason: "language_selected_terms_required",
        });
      }
      return attachDismissedSubscriptionOffer({
        ...resolvedPassthrough,
        ...contextFields,
        decision: "noop",
        action: hasStartedScene ? "show_newscene_confirm" : "show_character_gallery",
        allowed: true,
        callback_answer_text: uxCopy.language?.updated ?? null,
        reason: hasStartedScene
          ? "language_updated_start_requires_scene_reset"
          : "language_updated_start",
      });
    }

    if (
      accessContext.terms_accepted_at == null
      && languageConfirmedAt == null
    ) {
      return attachDismissedSubscriptionOffer({
        ...resolvedPassthrough,
        ...contextFields,
        decision: "show_language_selector",
        action: "show_language_selector",
        language_options: languageOptions,
        allowed: false,
        reason: "language_selection_required",
      });
    }

    if (
      requiresTermsGate(classification) &&
      accessContext.terms_accepted_at == null
    ) {
      return attachDismissedSubscriptionOffer({
        ...resolvedPassthrough,
        ...contextFields,
        decision: "show_terms_gate",
        action: "show_terms_gate",
        allowed: false,
        post_accept_intent: resolvePostAcceptIntent(classification),
        terms_offer_url: legalUrl(resolvedLanguage, "terms"),
        privacy_policy_url: legalUrl(resolvedLanguage, "privacy"),
        reason: "terms_not_accepted",
      });
    }

    if (classification.intent === "scene_start") {
      return attachDismissedSubscriptionOffer({
        ...resolvedPassthrough,
        ...contextFields,
        decision: "noop",
        action: hasStartedScene ? "show_newscene_confirm" : "show_character_gallery",
        allowed: true,
        reason: hasStartedScene ? "scene_start_requires_scene_reset" : "scene_start",
      });
    }

    if (classification.intent === "menu") {
      return attachDismissedSubscriptionOffer({
        ...resolvedPassthrough,
        ...contextFields,
        decision: "noop",
        action: "show_character_gallery",
        allowed: true,
        reason: "menu",
      });
    }

    if (classification.intent === "subscription") {
      if (accessContext.subscription_active) {
        if (hasAvailableFullUpgrade(accessContext)) {
          return attachDismissedSubscriptionOffer({
            ...resolvedPassthrough,
            ...contextFields,
            decision: "show_subscription_offer",
            action: "show_subscription_offer",
            allowed: true,
            subscription_offer_reason: "subscription_command",
            reason: "subscription_upgrade_available",
          });
        }
        return attachDismissedSubscriptionOffer({
          ...resolvedPassthrough,
          ...contextFields,
          decision: "show_subscription_status",
          action: "show_subscription_status",
          allowed: true,
          text: formatSubscriptionStatusText(accessContext, uxCopy),
          parse_mode: null,
          disable_web_page_preview: true,
          reason: "subscription_active",
        });
      }

      return attachDismissedSubscriptionOffer({
        ...resolvedPassthrough,
        ...contextFields,
        decision: "show_subscription_offer",
        action: "show_subscription_offer",
        allowed: true,
        subscription_offer_reason: "subscription_command",
        reason: "subscription_inactive",
      });
    }

    if (classification.intent === "paysupport") {
      return attachDismissedSubscriptionOffer({
        ...resolvedPassthrough,
        ...contextFields,
        decision: "noop",
        action: "send_paysupport_message",
        allowed: true,
        text: formatPaysupportText(accessContext, uxCopy),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reason: "paysupport",
      });
    }

    if (requiresSceneAccessCheck(classification)) {
      const inboundId = normalizePositiveInteger(input.inbound_message_id);
      const updateId = normalizePositiveInteger(input.update_id);
      if (!accessContext.user_id || (inboundId == null && updateId == null)) {
        throw new Error('Scene message is missing its account or ingress identifier');
      }
      const admitted = await this.repository.admitMessage(
        accessContext.user_id, accessContext.chat_id,
        inboundId != null ? `${input.chat_id}:${inboundId}` : `update:${updateId}`,
        config.BUSINESS_TIME_ZONE, config.DAILY_FREE_LIMITS_JSON.messages,
      );
      const admittedFields = {
        ...contextFields,
        turns_today: admitted.turnsToday,
        subscription_active: admitted.subscriptionActive,
        scene_access_active: admitted.sceneAccessActive,
      };
      if (admitted.allowed) {
        return attachDismissedSubscriptionOffer({
          ...resolvedPassthrough,
          ...admittedFields,
          decision: "allow_scene",
          action: "run_scene_core",
          allowed: true,
          reason: admitted.subscriptionActive
            ? "subscription_active"
            : admitted.sceneAccessActive
              ? "scene_access_active"
            : "within_daily_limit",
        });
      }

      return attachDismissedSubscriptionOffer({
        ...resolvedPassthrough,
        ...admittedFields,
        decision: "show_subscription_offer",
        action: "show_subscription_offer",
        allowed: false,
        subscription_offer_reason: "daily_turn_limit",
        reason: "daily_turn_limit_reached",
      });
    }

    return attachDismissedSubscriptionOffer({
      ...resolvedPassthrough,
      ...contextFields,
      decision: "noop",
      allowed: true,
      reason: classification.intent,
    });
  }
}
