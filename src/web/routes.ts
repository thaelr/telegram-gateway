import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { WebAuthError, type WebAuthenticator } from "./auth.js";
import { WebError, type WebIdentity, type WebRepositoryContract } from "./types.js";

export type WebRoutesOptions = {
  authenticator: WebAuthenticator;
  repository: WebRepositoryContract;
};

const clientId = z.string().trim().min(1).max(128);
const chatCode = z.string().regex(/^c[a-z0-9]{7}$/u);
const codeParams = z.object({ chat_code: chatCode }).strict();
const characterId = z.coerce.number().int().positive().max(32767);
const sceneMode = z.enum(["fast", "roleplay"]);
const pageLimit = z.coerce.number().int().min(1).max(100).optional();

export function registerWebRoutes(app: FastifyInstance, options: WebRoutesOptions): void {
  void app.register(async (scope) => {
    const identities = new WeakMap<FastifyRequest, WebIdentity>();
    const users = new WeakMap<FastifyRequest, string>();
    const repository = options.repository;
    const user = (request: FastifyRequest): string => {
      const id = users.get(request);
      if (!id) throw new WebError(409, "bootstrap_required");
      return id;
    };
    const consent = async (request: FastifyRequest): Promise<string> => {
      const id = user(request);
      const profile = await repository.getMe(id);
      if (!profile.age_confirmed_at) throw new WebError(403, "age_confirmation_required");
      if (!profile.terms_accepted_at) throw new WebError(403, "terms_acceptance_required");
      return id;
    };
    scope.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      reply.header("Vary", "Authorization");
      const identity = await options.authenticator.verify(request.headers.authorization);
      identities.set(request, identity);
      if (request.routeOptions.url !== "/web/auth/bootstrap") {
        const userId = await repository.resolveIdentity(identity.auth_user_id);
        if (!userId) throw new WebError(409, "bootstrap_required");
        users.set(request, userId);
      }
    });
    scope.setErrorHandler((error, request, reply) => {
      if (error instanceof WebError || error instanceof WebAuthError) {
        return reply.status(error.statusCode).send({ error: error.code });
      }
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: "invalid_request", issues: error.issues.map(({ path, message }) => ({ path, message })) });
      }
      if (typeof error === "object" && error != null && "statusCode" in error
        && (error.statusCode === 400 || error.statusCode === 413 || error.statusCode === 415)) {
        return reply.status(error.statusCode).send({ error: "invalid_request" });
      }
      // Do not serialize SQL errors, auth bearer headers, or private model inputs.
      request.log.error({ request_id: request.id }, "Web API operation failed");
      return reply.status(500).send({ error: "internal_error", request_id: request.id });
    });

    scope.post("/web/auth/bootstrap", async (request) => {
      z.object({}).strict().parse(request.body ?? {});
      return repository.bootstrap(identities.get(request)!);
    });
    scope.get("/web/me", async (request) => repository.getMe(user(request)));
    scope.patch("/web/me", async (request) => {
      const patch = z.object({ display_name: z.string().trim().min(1).max(120).optional(), language: z.enum(["ru", "en"]).optional() })
        .strict().refine((value) => Object.keys(value).length > 0).parse(request.body);
      return repository.updateMe(user(request), patch);
    });
    scope.post("/web/me/confirm-age", async (request) => {
      z.object({ confirmed: z.literal(true) }).strict().parse(request.body);
      return repository.confirmAge(user(request));
    });
    scope.post("/web/me/accept-terms", async (request) => {
      z.object({ accepted: z.literal(true) }).strict().parse(request.body);
      return repository.acceptTerms(user(request));
    });
    scope.get("/web/characters", async (request) => ({ characters: await repository.listCharacters(user(request)) }));
    scope.get("/web/characters/:character_i", async (request) => {
      const params = z.object({ character_i: characterId }).strict().parse(request.params);
      return repository.getCharacter(user(request), params.character_i);
    });
    scope.get("/web/chats", async (request) => ({ chats: await repository.listChats(user(request)) }));
    scope.post("/web/chats", async (request, reply) => {
      const input = z.object({ character_i: characterId, scene_mode: sceneMode, client_message_id: clientId.optional() }).strict().parse(request.body);
      const result = await repository.createChat(await consent(request), input.character_i, input.scene_mode, input.client_message_id ?? randomUUID());
      return reply.status(result.operation ? 202 : 200).send(result);
    });
    scope.get("/web/chats/:chat_code", async (request) => {
      const params = codeParams.parse(request.params);
      return repository.getChat(user(request), params.chat_code);
    });
    scope.post("/web/chats/:chat_code/reset", async (request, reply) => {
      const params = codeParams.parse(request.params);
      const input = z.object({ client_message_id: clientId }).strict().parse(request.body);
      const operation = await repository.enqueue(await consent(request), params.chat_code, "reset", input.client_message_id);
      return reply.status(202).send(operation);
    });
    scope.get("/web/chats/:chat_code/messages", async (request) => {
      const params = codeParams.parse(request.params);
      const query = z.object({ before: z.string().min(1).max(256).optional(), limit: pageLimit }).strict().parse(request.query);
      return repository.history(user(request), params.chat_code, query.before, query.limit);
    });
    scope.post("/web/chats/:chat_code/messages", { bodyLimit: 32_768 }, async (request, reply) => {
      const params = codeParams.parse(request.params);
      const input = z.object({ client_message_id: clientId, text: z.string().trim().min(1).max(4000) }).strict().parse(request.body);
      const operation = await repository.enqueue(await consent(request), params.chat_code, "message", input.client_message_id, input.text);
      return reply.status(202).send(operation);
    });
    scope.get("/web/chats/:chat_code/events", async (request) => {
      const params = codeParams.parse(request.params);
      const query = z.object({ after: z.string().regex(/^\d{1,20}$/u).optional(), limit: pageLimit }).strict().parse(request.query);
      return repository.events(user(request), params.chat_code, query.after, query.limit);
    });
    scope.get("/web/chats/:chat_code/continuation", async (request) => {
      const params = codeParams.parse(request.params);
      return repository.continuation(user(request), params.chat_code);
    });
  });
}
