import "dotenv/config";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { sql } from "./db.js";
import { ChatAccessRepository } from "./chatAccessRepository.js";
import { AccessDecisionService } from "./accessDecisionService.js";
import { MediaCommerceRepository } from "./mediaCommerceRepository.js";
import {
  MediaCommerceDecisionService,
  MediaCommerceOperationError,
} from "./mediaCommerceDecisionService.js";
import { mediaCommerceRequestSchema } from "./mediaCommerce/requestSchema.js";
import { isInternalApiAuthorized } from "./internalApiAuth.js";
import { runWithRequestContext } from "./requestContext.js";
import { RewardRepository } from "./rewardRepository.js";
import { RewardService, RewardUnavailableError } from "./rewardService.js";
import {
  nonNegativeIntegerInputSchema,
  positiveIntegerInputSchema,
} from "./numericSchemas.js";

const routerRequestSchema = z.object({
  chat_id: positiveIntegerInputSchema,
  source: z.string().trim().nullable().optional(),
  update_id: positiveIntegerInputSchema.nullable().optional(),
  source_user_id: positiveIntegerInputSchema.nullable().optional(),
  command: z.string().trim().nullable().optional(),
  event_type: z.string().trim().nullable().optional(),
  route_target: z.string().trim().nullable().optional(),
  message_type: z.string().trim().nullable().optional(),
  user_message: z.string().nullable().optional(),
  raw_update: z.unknown().nullable().optional(),
  inbound_message_id: positiveIntegerInputSchema.nullable().optional(),
  character_i: positiveIntegerInputSchema.nullable().optional(),
  scene_mode: z.string().trim().nullable().optional(),
  callback_data: z.string().trim().nullable().optional(),
  callback_query_id: z.string().trim().nullable().optional(),
  panel_text: z.string().nullable().optional(),
  panel_entities_json: z.unknown().nullable().optional(),
  pre_checkout_query_id: z.string().trim().nullable().optional(),
  invoice_payload: z.string().trim().nullable().optional(),
  telegram_payment_charge_id: z.string().trim().nullable().optional(),
  provider_payment_charge_id: z.string().trim().nullable().optional(),
  payment_currency: z.string().trim().nullable().optional(),
  payment_total_amount: nonNegativeIntegerInputSchema.nullable().optional(),
  reachability_status: z.string().trim().nullable().optional(),
  telegram_chat_status: z.string().trim().nullable().optional(),
});

type RouterDecisionEvaluator = Pick<AccessDecisionService, "evaluate">;
type MediaCommerceDecisionEvaluator = Pick<MediaCommerceDecisionService, "evaluate">;
type SbpCheckoutResolver = Pick<MediaCommerceDecisionService, "resolveSbpCheckout">;
type RewardClaimer = Pick<
  RewardService,
  "claimReward" | "claimConfiguredSlot" | "assignConfiguredSlot" | "bindGrantMessage"
>;

type BuildAppOptions = {
  accessDecisionService?: RouterDecisionEvaluator;
  mediaCommerceDecisionService?: MediaCommerceDecisionEvaluator;
  sbpCheckoutService?: SbpCheckoutResolver;
  rewardService?: RewardClaimer;
  logger?: boolean;
};

function extractPostgresCode(error: unknown): string | null {
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

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
  });

  const accessDecisionService = options.accessDecisionService
    ?? new AccessDecisionService(new ChatAccessRepository());
  const defaultMediaCommerceService =
    options.mediaCommerceDecisionService == null || options.sbpCheckoutService == null
      ? new MediaCommerceDecisionService(new MediaCommerceRepository())
      : null;
  const mediaCommerceDecisionService = options.mediaCommerceDecisionService
    ?? defaultMediaCommerceService!;
  const sbpCheckoutService = options.sbpCheckoutService
    ?? defaultMediaCommerceService!;
  const rewardService = options.rewardService
    ?? new RewardService(new RewardRepository(), config.REWARD_SLOTS_JSON);

  app.get("/healthz", async () => ({ ok: true }));

  app.addHook("onRequest", async (request, reply) => {
    const isPublicSbpRedirect =
      request.method === "GET"
      && /^\/v1\/pay\/sbp\/[^/?]+(?:\?.*)?$/u.test(request.raw.url ?? "");
    if (
      !request.raw.url?.startsWith("/v1/")
      || isPublicSbpRedirect
    ) {
      return;
    }

    if (
      !isInternalApiAuthorized(
        request.headers,
        config.INTERNAL_API_KEY_HEADER,
        config.INTERNAL_API_KEY,
      )
    ) {
      return reply.status(401).send({ error: "unauthorized" });
    }
  });

  const handleRouterDecision = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const parsed = routerRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        issues: parsed.error.issues,
      });
    }

    const result = await accessDecisionService.evaluate(parsed.data);
    return reply.send(result);
  };

  const handleMediaCommerceDecision = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const parsed = mediaCommerceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        issues: parsed.error.issues,
      });
    }

    try {
      const result = await runWithRequestContext(
        { requestId: request.id },
        () => mediaCommerceDecisionService.evaluate(parsed.data),
      );
      return reply.send(result);
    } catch (error) {
      const operation = error instanceof MediaCommerceOperationError
        ? error.operation
        : "unknown";
      const code = error instanceof MediaCommerceOperationError
        ? error.code
        : extractPostgresCode(error);

      request.log.error(
        {
          request_id: request.id,
          operation,
          code,
          err: error,
        },
        "MediaCommerce operation failed",
      );

      return reply.status(500).send({
        statusCode: 500,
        error: "Internal Server Error",
        message: "MediaCommerce operation failed",
        request_id: request.id,
        operation,
        code,
      });
    }
  };

  app.post("/v1/router-decision", handleRouterDecision);
  app.post("/v1/media-commerce-decision", handleMediaCommerceDecision);
  app.get("/v1/pay/sbp/:token", async (request, reply) => {
    const parsed = z.object({
      token: z.string().trim().min(1),
    }).safeParse(request.params);
    if (!parsed.success) {
      return reply.status(404).send({ error: "payment_not_found" });
    }

    try {
      const checkoutUrl = await runWithRequestContext(
        { requestId: request.id },
        () => sbpCheckoutService.resolveSbpCheckout(parsed.data.token),
      );
      return reply.redirect(checkoutUrl, 302);
    } catch (error) {
      if (!(error instanceof MediaCommerceOperationError)) throw error;

      if (error.code === "sbp_invoice_not_found") {
        return reply.status(404).send({ error: "payment_not_found" });
      }
      if ([
        "sbp_invoice_kind_invalid",
        "sbp_payment_source_invalid",
        "sbp_invoice_status_invalid",
        "sbp_invoice_action_invalid",
        "sbp_invoice_expired",
        "sbp_provider_status_pending",
        "sbp_provider_status_confirmed",
        "sbp_provider_status_chargebacked",
        "sbp_successor_context_stale",
        "sbp_retry_chain_corrupt",
      ].includes(error.code ?? "")) {
        return reply.status(410).send({ error: "payment_unavailable" });
      }
      if (error.code === "sbp_checkout_creation_in_progress") {
        return reply.status(409).send({ error: "payment_creation_in_progress" });
      }
      if (error.code === "sbp_checkout_creation_uncertain") {
        return reply.status(503).send({ error: "payment_reconciliation_required" });
      }
      if (error.code === "sbp_provider_status_ambiguous") {
        return reply.status(503).send({ error: "payment_reconciliation_required" });
      }
      throw error;
    }
  });
  app.post("/v1/rewards/claim-slot", async (request, reply) => {
    const parsed = z.object({
      chat_id: positiveIntegerInputSchema,
      reward_slot: positiveIntegerInputSchema,
      callback_query_id: z.string().trim().nullable().optional(),
      source_user_id: positiveIntegerInputSchema.nullable().optional(),
      inbound_message_id: positiveIntegerInputSchema.nullable().optional(),
      raw_update: z.unknown().nullable().optional(),
    }).safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        issues: parsed.error.issues,
      });
    }

    try {
      const result = await rewardService.claimConfiguredSlot({
        chatId: parsed.data.chat_id,
        slot: parsed.data.reward_slot,
        telegramMessageId: parsed.data.inbound_message_id ?? null,
      });
      return reply.send({
        ...parsed.data,
        ...result,
      });
    } catch (error) {
      if (error instanceof RewardUnavailableError) {
        return reply.send({
          status: "unavailable",
          callback_answer_text: "Подарок недоступен",
          next_action: null,
          reward_slot: parsed.data.reward_slot,
          chat_id: parsed.data.chat_id,
          callback_query_id: parsed.data.callback_query_id ?? null,
          source_user_id: parsed.data.source_user_id ?? null,
          inbound_message_id: parsed.data.inbound_message_id ?? null,
          raw_update: parsed.data.raw_update ?? null,
        });
      }
      throw error;
    }
  });
  app.post("/v1/rewards/claim", async (request, reply) => {
    const parsed = z.object({
      chat_id: positiveIntegerInputSchema,
      campaign_id: z.string().trim().min(1),
    }).safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        issues: parsed.error.issues,
      });
    }

    try {
      return reply.send(await rewardService.claimReward({
        chatId: parsed.data.chat_id,
        campaignId: parsed.data.campaign_id,
      }));
    } catch (error) {
      if (error instanceof RewardUnavailableError) {
        return reply.send({
          status: "unavailable",
          campaign_id: parsed.data.campaign_id,
        });
      }
      throw error;
    }
  });
  app.post("/v1/rewards/grants", async (request, reply) => {
    const parsed = z.object({
      chat_id: positiveIntegerInputSchema,
      reward_slot: positiveIntegerInputSchema,
    }).safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        issues: parsed.error.issues,
      });
    }

    try {
      return reply.send(await rewardService.assignConfiguredSlot({
        chatId: parsed.data.chat_id,
        slot: parsed.data.reward_slot,
      }));
    } catch (error) {
      if (error instanceof RewardUnavailableError) {
        return reply.status(409).send({
          chat_id: parsed.data.chat_id,
          slot: parsed.data.reward_slot,
          status: "unavailable",
        });
      }
      throw error;
    }
  });
  app.post("/v1/rewards/grants/:grantId/bind-message", async (request, reply) => {
    const params = z.object({
      grantId: positiveIntegerInputSchema,
    }).safeParse(request.params);
    const body = z.object({
      telegram_message_id: positiveIntegerInputSchema,
    }).safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        error: "invalid_request",
        issues: [
          ...(params.success ? [] : params.error.issues),
          ...(body.success ? [] : body.error.issues),
        ],
      });
    }

    try {
      return reply.send(await rewardService.bindGrantMessage({
        grantId: params.data.grantId,
        telegramMessageId: body.data.telegram_message_id,
      }));
    } catch (error) {
      if (error instanceof RewardUnavailableError) {
        return reply.status(404).send({
          grant_id: params.data.grantId,
          status: "not_found",
        });
      }
      throw error;
    }
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = buildApp();
  const shutdown = async () => {
    await app.close();
    await sql.end({ timeout: 5 });
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  }

  app
    .listen({
      host: config.HOST,
      port: config.PORT,
    })
    .catch((error) => {
      app.log.error(error);
      process.exit(1);
    });
}
