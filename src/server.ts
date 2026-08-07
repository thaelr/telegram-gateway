import "dotenv/config";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { sql } from "./db.js";
import { ChatAccessRepository } from "./chatAccessRepository.js";
import { AccessDecisionService } from "./accessDecisionService.js";

const requestSchema = z.object({
  chat_id: z.coerce.number().int().positive(),
  source: z.string().trim().nullable().optional(),
  update_id: z.coerce.number().int().positive().nullable().optional(),
  source_user_id: z.coerce.number().int().positive().nullable().optional(),
  command: z.string().trim().nullable().optional(),
  event_type: z.string().trim().nullable().optional(),
  route_target: z.string().trim().nullable().optional(),
  message_type: z.string().trim().nullable().optional(),
  user_message: z.string().nullable().optional(),
  inbound_message_id: z.coerce.number().int().positive().nullable().optional(),
  character_i: z.coerce.number().int().positive().nullable().optional(),
  scene_mode: z.string().trim().nullable().optional(),
  callback_data: z.string().trim().nullable().optional(),
  callback_query_id: z.string().trim().nullable().optional(),
  pre_checkout_query_id: z.string().trim().nullable().optional(),
  invoice_payload: z.string().trim().nullable().optional(),
  telegram_payment_charge_id: z.string().trim().nullable().optional(),
  provider_payment_charge_id: z.string().trim().nullable().optional(),
  payment_currency: z.string().trim().nullable().optional(),
  payment_total_amount: z.coerce.number().int().nonnegative().nullable().optional(),
  reachability_status: z.string().trim().nullable().optional(),
  telegram_chat_status: z.string().trim().nullable().optional(),
});

const app = Fastify({
  logger: true,
});

const service = new AccessDecisionService(new ChatAccessRepository());

app.get("/healthz", async () => ({ ok: true }));

const handleRouterDecision = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const parsed = requestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      error: "invalid_request",
      issues: parsed.error.issues,
    });
  }

  const result = await service.evaluate(parsed.data);
  return reply.send(result);
};

app.post("/v1/access-decision", handleRouterDecision);
app.post("/v1/router-decision", handleRouterDecision);

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
