import { config } from "./config.js";
import { ChatAccessRepository } from "./chatAccessRepository.js";
import { prependFreeBalances } from "./freeBalanceFormatter.js";
import { normalizeNonNegativeInteger, normalizePositiveInteger } from "./numeric.js";
import type {
  AccessContext,
  AccessDecisionRequest,
  AccessDecisionResponse,
  RouterAction,
  RouterDomain,
  RouterIntent,
} from "./types.js";

const START_COMMAND = "/start";
const MENU_COMMAND = "/menu";
const SUBSCRIPTION_COMMAND = "/subscription";
const PAYSUPPORT_COMMAND = "/paysupport";

const ACCESS_CONTEXT_INTENTS = new Set<RouterIntent>([
  "scene_start",
  "menu",
  "subscription",
  "paysupport",
  "scene_mode",
  "scene_message",
]);

type RouterClassification = {
  domain: RouterDomain;
  intent: RouterIntent;
  action: RouterAction;
  character_i?: number | null;
  scene_mode?: string | null;
  reward_slot?: number | null;
  post_accept_intent?: "start" | "menu" | "subscription" | "paysupport" | null;
  newscene_action?: "yes" | "no" | null;
};

type AccessRepository = Pick<
  ChatAccessRepository,
  "ensureAndLoadAccessContext" | "popActiveSubscriptionOffer"
>;

function isAllowedClassification(classification: RouterClassification): boolean {
  switch (classification.intent) {
    case "scene_start":
    case "menu":
    case "subscription":
    case "paysupport":
    case "terms_accept":
    case "reward_claim":
    case "newscene_confirm":
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

function requiresTermsGate(classification: RouterClassification): boolean {
  return ACCESS_CONTEXT_INTENTS.has(classification.intent);
}

function requiresSceneAccessCheck(classification: RouterClassification): boolean {
  return classification.intent === "scene_message";
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
      if (parts.length !== 2 || !["yes", "no"].includes(parts[1] ?? "")) {
        return ignoreStructuredCallback();
      }
      return {
        domain: "interaction",
        intent: "newscene_confirm",
        action: "handle_newscene_confirm",
        newscene_action: parts[1] as "yes" | "no",
      };
    }
    case "character_select": {
      if (parts.length !== 2) return ignoreStructuredCallback();
      const characterId = normalizePositiveInteger(parts[1]);
      if (characterId == null) return ignoreStructuredCallback();
      return {
        domain: "interaction",
        intent: "character_select",
        action: "show_character_mode_screen",
        character_i: characterId,
      };
    }
    case "character_menu": {
      if (parts.length !== 2 || parts[1] !== "back") return ignoreStructuredCallback();
      return {
        domain: "interaction",
        intent: "character_back",
        action: "handle_character_back",
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

function formatSubscriptionStatusText(context: AccessContext): string {
  const text = config.TELEGRAM_UX_COPY_JSON.subscription.active
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
  return prependFreeBalances(text, context) ?? text;
}

function replaceCount(template: string, count: number): string {
  return template.replaceAll("{count}", String(count));
}

function formatPaysupportText(context: AccessContext): string {
  const copy = config.TELEGRAM_UX_COPY_JSON.paysupport;
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

export class AccessDecisionService {
  constructor(private readonly repository: AccessRepository) {}

  async evaluate(
    input: AccessDecisionRequest,
  ): Promise<AccessDecisionResponse> {
    const classification = classifyRouterInput(input);
    const source = normalizeSource(input.source);
    const idempotencyKey = buildIdempotencyKey(source, input.update_id);
    const effectiveCharacterId =
      classification.character_i ?? input.character_i ?? null;
    const effectiveSceneMode = classification.scene_mode ?? input.scene_mode ?? null;
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
        input.chat_id,
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
      scene_mode: effectiveSceneMode,
      reward_slot: classification.reward_slot ?? null,
      post_accept_intent: classification.post_accept_intent ?? null,
      newscene_action: classification.newscene_action ?? null,
      ux_copy: config.TELEGRAM_UX_COPY_JSON,
    } as const;

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
    );

    const hasSceneSession = Boolean(accessContext.active_scene_session_id);
    const hasStartedScene = accessContext.scene_turn_no >= 0;
    const contextFields = {
      terms_accepted_at: accessContext.terms_accepted_at,
      subscription_active: accessContext.subscription_active,
      subscription_sku: accessContext.subscription_sku,
      subscription_until: accessContext.subscription_until,
      scene_session_id: hasSceneSession ? accessContext.active_scene_session_id : null,
      active_scene_session_id: accessContext.active_scene_session_id,
      scene_turn_no:
        hasSceneSession && hasStartedScene
          ? accessContext.scene_turn_no
          : null,
      scene_access_active: accessContext.scene_access_active,
      free_fast_scene_skips: accessContext.free_fast_scene_skips,
      free_scene_unlocks: accessContext.free_scene_unlocks,
      free_photo_unlocks: accessContext.free_photo_unlocks,
      turns_today: accessContext.turns_today,
      turn_limit: config.TURN_LIMIT,
      turn_limit_reset_text: config.TURN_LIMIT_RESET_TEXT,
      selected_character_i: accessContext.selected_character_i,
      active_menu_screen: accessContext.active_menu_screen,
      active_menu_message_id: accessContext.active_menu_message_id,
    } as const;

    if (
      requiresTermsGate(classification) &&
      accessContext.terms_accepted_at == null
    ) {
      return attachDismissedSubscriptionOffer({
        ...passthrough,
        ...contextFields,
        decision: "show_terms_gate",
        action: "show_terms_gate",
        allowed: false,
        post_accept_intent: resolvePostAcceptIntent(classification),
        terms_offer_url: config.PUBLIC_OFFER_URL,
        reason: "terms_not_accepted",
      });
    }

    if (classification.intent === "scene_start") {
      return attachDismissedSubscriptionOffer({
        ...passthrough,
        ...contextFields,
        decision: "noop",
        action: hasStartedScene ? "show_newscene_confirm" : "show_character_gallery",
        allowed: true,
        reason: hasStartedScene ? "scene_start_requires_scene_reset" : "scene_start",
      });
    }

    if (classification.intent === "menu") {
      return attachDismissedSubscriptionOffer({
        ...passthrough,
        ...contextFields,
        decision: "noop",
        action: hasStartedScene ? "show_newscene_confirm" : "show_character_gallery",
        allowed: true,
        reason: hasStartedScene ? "menu_requires_scene_reset" : "menu",
      });
    }

    if (classification.intent === "subscription") {
      if (accessContext.subscription_active) {
        return attachDismissedSubscriptionOffer({
          ...passthrough,
          ...contextFields,
          decision: "show_subscription_status",
          action: "show_subscription_status",
          allowed: true,
          text: formatSubscriptionStatusText(accessContext),
          parse_mode: null,
          disable_web_page_preview: true,
          reason: "subscription_active",
        });
      }

      return attachDismissedSubscriptionOffer({
        ...passthrough,
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
        ...passthrough,
        ...contextFields,
        decision: "noop",
        action: "send_paysupport_message",
        allowed: true,
        text: formatPaysupportText(accessContext),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reason: "paysupport",
      });
    }

    if (requiresSceneAccessCheck(classification)) {
      if (
        accessContext.subscription_active ||
        accessContext.scene_access_active ||
        accessContext.turns_today < config.TURN_LIMIT
      ) {
        return attachDismissedSubscriptionOffer({
          ...passthrough,
          ...contextFields,
          decision: "allow_scene",
          action: "run_scene_core",
          allowed: true,
          reason: accessContext.subscription_active
            ? "subscription_active"
            : accessContext.scene_access_active
              ? "scene_access_active"
            : "within_daily_limit",
        });
      }

      return attachDismissedSubscriptionOffer({
        ...passthrough,
        ...contextFields,
        decision: "show_subscription_offer",
        action: "show_subscription_offer",
        allowed: false,
        subscription_offer_reason: "daily_turn_limit",
        reason: "daily_turn_limit_reached",
      });
    }

    return attachDismissedSubscriptionOffer({
      ...passthrough,
      ...contextFields,
      decision: "noop",
      allowed: true,
      reason: classification.intent,
    });
  }
}
