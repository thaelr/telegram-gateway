import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { WebAuthError, type WebAuthenticator } from './auth.js';
import { WebError, type WebIdentity, type WebRepositoryContract } from './types.js';
import type { WebFeaturesRepositoryContract } from './featuresTypes.js';
import { linkHash, type TelegramProofVerifier } from './telegramLink.js';

export type WebFeaturesOptions = {
  authenticator: WebAuthenticator; repository: WebRepositoryContract;
  features: WebFeaturesRepositoryContract; telegramClientId: string;
  telegramVerifier: TelegramProofVerifier;
};

export function registerWebFeatures(app: FastifyInstance, options: WebFeaturesOptions): void {
  void app.register(async scope => {
    const callers = new WeakMap<FastifyRequest, { userId: string; identity: WebIdentity }>();
    scope.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store'); reply.header('Vary', 'Authorization');
      const identity = await options.authenticator.verify(request.headers.authorization);
      const userId = await options.repository.resolveIdentity(identity.auth_user_id);
      if (!userId) throw new WebError(409, 'bootstrap_required');
      callers.set(request, { userId, identity });
    });
    scope.setErrorHandler((error, request, reply) => {
      if (error instanceof WebError || error instanceof WebAuthError) return reply.status(error.statusCode).send({ error: error.code });
      if (error instanceof z.ZodError) return reply.status(400).send({ error: 'invalid_request' });
      if (error && typeof error === 'object' && 'statusCode' in error
        && [400, 413, 415].includes(Number(error.statusCode))) return reply.status(Number(error.statusCode)).send({ error: 'invalid_request' });
      request.log.error({ request_id: request.id }, 'Web account operation failed');
      return reply.status(500).send({ error: 'internal_error', request_id: request.id });
    });
    const current = (request: FastifyRequest) => callers.get(request)!;
    const consent = async (request: FastifyRequest): Promise<string> => {
      const { userId } = current(request); const me = await options.repository.getMe(userId);
      if (!me.language_confirmed_at && !me.terms_accepted_at) throw new WebError(403, 'language_selection_required');
      if (!me.age_confirmed_at) throw new WebError(403, 'age_confirmation_required');
      if (!me.terms_accepted_at) throw new WebError(403, 'terms_acceptance_required');
      return userId;
    };
    scope.get('/web/publications', async request => {
      const query = z.object({ before: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict().parse(request.query);
      return options.features.publications(current(request).userId, query.before, query.limit);
    });
    scope.get('/web/voting', request => options.features.voting(current(request).userId));
    scope.post('/web/voting/:campaign_id/vote', async request => {
      const { campaign_id } = z.object({ campaign_id: z.string().uuid() }).strict().parse(request.params);
      const { candidate_id } = z.object({ candidate_id: z.string().uuid() }).strict().parse(request.body);
      const userId = await consent(request);
      await options.features.castVote(userId, campaign_id, candidate_id);
      return options.features.voting(userId);
    });
    scope.get('/web/chat-summaries', request => options.features.summaries(current(request).userId));
    scope.post('/web/chats/:chat_code/read', async request => {
      const { chat_code } = z.object({ chat_code: z.string().regex(/^c[a-z0-9]{7}$/) }).strict().parse(request.params);
      const { message_id } = z.object({ message_id: z.string().min(1).max(128) }).strict().parse(request.body);
      return options.features.markRead(current(request).userId, chat_code, message_id);
    });
    scope.get('/web/me/telegram-link', async request => ({
      ...await options.features.telegramStatus(current(request).userId), available: Boolean(options.telegramClientId),
    }));
    scope.post('/web/me/telegram-link', async request => {
      z.object({}).strict().parse(request.body ?? {});
      if (!options.telegramClientId) throw new WebError(503, 'telegram_login_unavailable');
      const userId = await consent(request); const { identity } = current(request);
      const challenge = randomBytes(32).toString('base64url');
      const result = await options.features.issueTelegramChallenge(userId, identity.auth_user_id, linkHash(challenge));
      return { challenge, client_id: options.telegramClientId, expires_at: result.expires_at };
    });
    scope.post('/web/me/telegram-link/complete', { bodyLimit: 24_576 }, async request => {
      if (!options.telegramClientId) throw new WebError(503, 'telegram_login_unavailable');
      const { challenge, id_token } = z.object({
        challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), id_token: z.string().min(1).max(16_384),
      }).strict().parse(request.body);
      const { userId, identity } = current(request); const hash = linkHash(challenge);
      const bound = await options.features.telegramChallenge(userId, identity.auth_user_id, hash);
      const telegramId = await options.telegramVerifier.verify(id_token, challenge);
      return options.features.completeTelegramLink(bound.user_id, identity.auth_user_id, hash, telegramId, linkHash(id_token));
    });
  });
}
