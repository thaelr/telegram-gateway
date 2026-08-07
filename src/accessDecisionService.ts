import { config } from "./config.js";
import { ChatAccessRepository } from "./chatAccessRepository.js";
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
const NEW_SCENE_COMMAND = "/newscene";
const SUBSCRIPTION_COMMAND = "/subscription";
const PAYSUPPORT_COMMAND = "/paysupport";

const ACCESS_CONTEXT_INTENTS = new Set<RouterIntent>([
  "scene_start",
  "menu",
  "new_scene",
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
};

type AccessRepository = Pick<ChatAccessRepository, "ensureAndLoadAccessContext">;

function isAllowedClassification(classification: RouterClassification): boolean {
  switch (classification.intent) {
    case "scene_start":
    case "menu":
    case "new_scene":
    case "subscription":
    case "paysupport":
    case "terms_accept":
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

function normalizePositiveInteger(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
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
  return (
    classification.intent === "scene_mode" ||
    classification.intent === "scene_message"
  );
}

function classifyRouterInput(input: AccessDecisionRequest): RouterClassification {
  const command = normalizeCommand(input.command);
  const routeTarget = String(input.route_target ?? "").trim();
  const eventType = String(input.event_type ?? "").trim();
  const callbackData = normalizeCallbackData(input.callback_data);

  if (callbackData?.startsWith("terms_accept")) {
    return {
      domain: "interaction",
      intent: "terms_accept",
      action: "handle_terms_accept",
    };
  }

  if (callbackData?.startsWith("newscene_confirm:")) {
    return {
      domain: "interaction",
      intent: "newscene_confirm",
      action: "handle_newscene_confirm",
    };
  }

  if (callbackData?.startsWith("character_select:")) {
    return {
      domain: "interaction",
      intent: "character_select",
      action: "show_character_mode_screen",
      character_i: normalizePositiveInteger(callbackData.split(":")[1]),
    };
  }

  if (callbackData === "character_menu:back") {
    return {
      domain: "interaction",
      intent: "character_back",
      action: "handle_character_back",
    };
  }

  if (callbackData?.startsWith("scene_mode:")) {
    const selected = callbackData.split(":")[1] || "roleplay";
    return {
      domain: "interaction",
      intent: "scene_mode",
      action: "handle_scene_mode",
      scene_mode: selected === "fast" ? "fast" : "roleplay",
    };
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

  if (command === NEW_SCENE_COMMAND) {
    return {
      domain: "command",
      intent: "new_scene",
      action: "show_newscene_confirm",
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
  const sku = String(context.subscription_sku ?? "");
  const rawUntil = context.subscription_until;
  const until = rawUntil ? new Date(rawUntil) : null;
  const formatter = new Intl.DateTimeFormat("ru-RU", {
    timeZone: config.BUSINESS_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const daysLeft = until
    ? Math.max(0, Math.ceil((until.getTime() - Date.now()) / 86_400_000))
    : 0;
  const label = sku.includes("14")
    ? "14 дней"
    : daysLeft <= 5
      ? "5 дней"
      : "30 дней";

  return [
    "Подписка активна.",
    "",
    `План: ${label}.`,
    `Действует до: ${until ? formatter.format(until) : "не указано"} МСК.`,
    `Осталось примерно: ${daysLeft} дн.`,
  ].join("\n");
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
      inbound_message_id: input.inbound_message_id ?? null,
      callback_data: input.callback_data ?? null,
      callback_query_id: input.callback_query_id ?? null,
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
    } as const;

    if (!requiresAccessContext(classification)) {
      return {
        ...passthrough,
        decision: "noop",
        allowed: isAllowedClassification(classification),
        reason: classification.intent,
      };
    }

    const accessContext = await this.repository.ensureAndLoadAccessContext(
      input.chat_id,
      source,
      input.source_user_id ?? null,
      config.BUSINESS_TIME_ZONE,
    );

    const contextFields = {
      terms_accepted_at: accessContext.terms_accepted_at,
      subscription_active: accessContext.subscription_active,
      subscription_sku: accessContext.subscription_sku,
      subscription_until: accessContext.subscription_until,
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
      return {
        ...passthrough,
        ...contextFields,
        decision: "show_terms_gate",
        action: "show_terms_gate",
        allowed: false,
        post_accept_intent: resolvePostAcceptIntent(classification),
        reason: "terms_not_accepted",
      };
    }

    if (
      classification.intent === "scene_start" ||
      classification.intent === "menu"
    ) {
      return {
        ...passthrough,
        ...contextFields,
        decision: "noop",
        action: "show_character_gallery",
        allowed: true,
        reason: classification.intent,
      };
    }

    if (classification.intent === "subscription") {
      if (accessContext.subscription_active) {
        return {
          ...passthrough,
          ...contextFields,
          decision: "show_subscription_status",
          action: "show_subscription_status",
          allowed: true,
          text: formatSubscriptionStatusText(accessContext),
          parse_mode: null,
          disable_web_page_preview: true,
          reason: "subscription_active",
        };
      }

      return {
        ...passthrough,
        ...contextFields,
        decision: "show_subscription_offer",
        action: "show_subscription_offer",
        allowed: true,
        subscription_offer_reason: "subscription_command",
        reason: "subscription_inactive",
      };
    }

    if (requiresSceneAccessCheck(classification)) {
      if (
        accessContext.subscription_active ||
        accessContext.turns_today < config.TURN_LIMIT
      ) {
        return {
          ...passthrough,
          ...contextFields,
          decision: "allow_scene",
          action:
            classification.intent === "scene_mode"
              ? "handle_scene_mode"
              : "run_scene_core",
          allowed: true,
          reason: accessContext.subscription_active
            ? "subscription_active"
            : "within_daily_limit",
        };
      }

      return {
        ...passthrough,
        ...contextFields,
        decision: "show_subscription_offer",
        action: "show_subscription_offer",
        allowed: false,
        subscription_offer_reason: "daily_turn_limit",
        reason: "daily_turn_limit_reached",
      };
    }

    return {
      ...passthrough,
      ...contextFields,
      decision: "noop",
      allowed: true,
      reason: classification.intent,
    };
  }
}
