import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebDeliveryTransport } from '../src/web/delivery.js';
import type { WebDeliveryEvent } from '../src/web/types.js';

test('paid fast scene reset retains only the trusted fulfillment context on the wire', async () => {
  const event: WebDeliveryEvent = {
    event_id: 'a4d434ca-4db2-4b86-8cc2-1564252c41ea', user_id: 'u0000001', chat_id: 101,
    character_i: 1, scene_mode: 'fast', source: 'web', action: 'reset',
    data: { client_message_id: 'purchase-reset-1', entry_mode: 'fast_scene_skip',
      payment_token: 'test-existing-payment-token', feature_key: 'fast_scene_skip' },
  };
  const requests: unknown[] = [];
  const transport = createWebDeliveryTransport({ url: 'https://example.com/hook', secret: 'server-secret',
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(String(options?.body)));
      return Response.json({ accepted: true, event_id: event.event_id });
    } });
  const augmented = { ...event, access_token: 'must-never-leave',
    data: { ...event.data, api_key: 'must-never-leave', user_message: 'must-not-be-sent-on-reset' } };
  await transport.send(augmented);
  await transport.send(augmented);
  assert.deepEqual(requests, [event, event]);

  await transport.send({ ...augmented, action: 'scene_start' });
  await transport.send({ ...augmented, action: 'message', data: { ...augmented.data, user_message: 'Hello' } });
  assert.deepEqual(requests[2], { ...event, action: 'scene_start', data: { client_message_id: 'purchase-reset-1' } });
  assert.deepEqual(requests[3], { ...event, action: 'message', data: { client_message_id: 'purchase-reset-1', user_message: 'Hello' } });
});
