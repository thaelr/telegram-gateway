import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createWebDeliveryTransport, WebDeliveryError, WebDeliveryWorker,
  type WebDeliveryStore, type WebDeliveryClaim, type WebDeliveryFailure } from '../src/web/delivery.js';
import type { WebDeliveryEvent } from '../src/web/types.js';

const event: WebDeliveryEvent = {
  event_id: 'a4d434ca-4db2-4b86-8cc2-1564252c41ea', user_id: 'u0000001',
  chat_id: 101, character_i: 1, scene_mode: 'roleplay', source: 'web', action: 'message',
  data: { user_message: 'Hello, how was your day?', client_message_id: 'browser-message-1' },
};
const ack = () => Response.json({ accepted: true, event_id: event.event_id }, { status: 202 });
const fetchReturning = (response: () => Response): typeof fetch => async () => response();

test('Web delivery performs an HTTP request to an explicitly enabled local receiver and strips accidental fields', async (t) => {
  const received: { body: unknown; secret: string | string[] | undefined }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    received.push({ body: JSON.parse(body), secret: req.headers['x-web-event-secret'] });
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: true, event_id: event.event_id }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const transport = createWebDeliveryTransport({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`,
    secret: 'server-only-secret', allowLoopbackHttp: true });
  await transport.send(Object.assign({}, event, { access_token: 'must-never-leave' }));
  assert.deepEqual(received, [{ body: event, secret: 'server-only-secret' }]);
  assert.equal(JSON.stringify(received[0]!.body).includes('secret'), false);
});

test('delivery requires HTTPS except explicit loopback test configuration', () => {
  assert.throws(() => createWebDeliveryTransport({ url: 'http://example.com/hook', secret: 'x', allowLoopbackHttp: true }), /HTTPS/);
  assert.throws(() => createWebDeliveryTransport({ url: 'http://localhost/hook', secret: 'x' }), /HTTPS/);
  assert.throws(() => createWebDeliveryTransport({ url: 'https://secret:password@example.com/hook', secret: 'x' }), /Invalid Web webhook URL/);
  assert.throws(() => createWebDeliveryTransport({ url: 'https://example.com/hook', secret: 'x', headerName: 'host' }), /header/);
});

test('delivery refuses redirects and does not forward server credentials', async () => {
  let calls = 0;
  const transport = createWebDeliveryTransport({ url: 'https://example.com/hook', secret: 'server-secret', fetchImpl: async (_url, options) => {
    calls += 1;
    assert.equal(options?.redirect, 'manual');
    return new Response('', { status: 302, headers: { location: 'https://other.example/hook' } });
  } });
  await assert.rejects(transport.send(event), (error: unknown) => error instanceof WebDeliveryError && error.code === 'http_302' && !error.retryable);
  assert.equal(calls, 1);
});

test('delivery acknowledges only the same durable event identity', async () => {
  for (const result of [{ event_id: 'other', accepted: true }, { event_id: event.event_id, completed: true }, {}]) {
    const transport = createWebDeliveryTransport({ url: 'https://example.com/hook', secret: 'x', fetchImpl: fetchReturning(() => Response.json(result)) });
    await assert.rejects(transport.send(event), (error: unknown) => error instanceof WebDeliveryError && error.code === 'invalid_acknowledgement');
  }
});

test('delivery bounds acknowledgement size and never exposes external error bodies', async () => {
  const huge = createWebDeliveryTransport({ url: 'https://example.com/hook', secret: 'x', fetchImpl: fetchReturning(() => new Response('x'.repeat(5_000))) });
  await assert.rejects(huge.send(event), /invalid_acknowledgement/);
  const denied = createWebDeliveryTransport({ url: 'https://example.com/hook', secret: 'x', fetchImpl: fetchReturning(() => new Response('private upstream diagnostic', { status: 401 })) });
  await assert.rejects(denied.send(event), (error: unknown) => error instanceof WebDeliveryError && error.message === 'http_401' && !error.retryable);
});

test('delivery timeout aborts an actual outstanding receiver request', async (t) => {
  let requested = false;
  const server = createServer(() => { requested = true; });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const transport = createWebDeliveryTransport({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`,
    secret: 'x', timeoutMs: 100, allowLoopbackHttp: true });
  await assert.rejects(transport.send(event), (error: unknown) => error instanceof WebDeliveryError && error.code === 'delivery_timeout' && error.retryable);
  assert.equal(requested, true);
});

/** Store mock tests transport recovery only. PostgreSQL atomic claims are tested separately. */
class LeaseStore implements WebDeliveryStore {
  attempts = 0;
  leaseToken = '';
  availableAt = 0;
  delivered = false;
  failed = false;
  failNextSettlement = false;
  failures: WebDeliveryFailure[] = [];
  async claimNext(input: { leaseToken: string; leaseMs: number; maxAttempts: number; now: Date }): Promise<WebDeliveryClaim | null> {
    if (this.delivered || this.failed || this.availableAt > input.now.getTime()) return null;
    this.attempts += 1;
    this.leaseToken = input.leaseToken;
    this.availableAt = input.now.getTime() + input.leaseMs;
    return { event, attempts: this.attempts, leaseToken: this.leaseToken };
  }
  async settleDelivered(eventId: string, leaseToken: string): Promise<void> {
    assert.equal(eventId, event.event_id);
    assert.equal(leaseToken, this.leaseToken);
    if (this.failNextSettlement) { this.failNextSettlement = false; throw new Error('test database unavailable'); }
    this.delivered = true;
  }
  async settleFailure(eventId: string, leaseToken: string, failure: WebDeliveryFailure): Promise<void> {
    assert.equal(eventId, event.event_id);
    assert.equal(leaseToken, this.leaseToken);
    this.failures.push(failure);
    this.failed = failure.terminal;
    this.availableAt = failure.retryAt?.getTime() ?? Infinity;
  }
}

test('restart after uncertain network failure reuses the event id and persisted attempt budget', async () => {
  const store = new LeaseStore();
  let now = 1_000;
  const payloads: string[] = [];
  const transport = createWebDeliveryTransport({ url: 'https://example.com/hook', secret: 'x', fetchImpl: async (_url, options) => {
    payloads.push(String(options?.body));
    if (payloads.length === 1) throw new Error('arbitrary private network detail');
    return ack();
  } });
  const first = new WebDeliveryWorker({ store, transport, now: () => new Date(now) });
  assert.equal(await first.runOnce(), 'retry');
  assert.equal(store.failures[0]?.code, 'delivery_network_error');
  assert.equal(await first.runOnce(), 'idle');
  now += 1_000;
  const restarted = new WebDeliveryWorker({ store, transport, now: () => new Date(now) });
  assert.equal(await restarted.runOnce(), 'delivered');
  assert.equal(store.attempts, 2);
  assert.equal(payloads[0], payloads[1]);
});

test('crash after receiver acceptance recovers expired lease with identical payload', async () => {
  const store = new LeaseStore();
  store.failNextSettlement = true;
  let now = 1_000;
  const payloads: string[] = [];
  const transport = createWebDeliveryTransport({ url: 'https://example.com/hook', secret: 'x', fetchImpl: async (_url, options) => {
    payloads.push(String(options?.body)); return ack();
  } });
  const first = new WebDeliveryWorker({ store, transport, now: () => new Date(now) });
  await assert.rejects(first.runOnce(), /test database unavailable/);
  const restarted = new WebDeliveryWorker({ store, transport, now: () => new Date(now) });
  assert.equal(await restarted.runOnce(), 'idle');
  now += 30_000;
  assert.equal(await restarted.runOnce(), 'delivered');
  assert.equal(payloads[0], payloads[1]);
  assert.deepEqual(store.failures, []);
});

test('bounded retries terminate delivery without inferring engine completion', async () => {
  const store = new LeaseStore();
  let now = 0;
  const transport = createWebDeliveryTransport({ url: 'https://example.com/hook', secret: 'x', fetchImpl: fetchReturning(() => new Response('', { status: 503 })) });
  const worker = new WebDeliveryWorker({ store, transport, maxAttempts: 2, now: () => new Date(now) });
  assert.equal(await worker.runOnce(), 'retry');
  now += 1_000;
  assert.equal(await worker.runOnce(), 'failed');
  assert.equal(store.failed, true);
  assert.equal(store.delivered, false);
  assert.equal(store.failures[1]?.retryAt, null);
  assert.equal(await worker.runOnce(), 'idle');
});

test('local concurrent worker calls share one in-flight claim and delivery', async () => {
  const store = new LeaseStore();
  const transport = createWebDeliveryTransport({ url: 'https://example.com/hook', secret: 'x', fetchImpl: fetchReturning(ack) });
  const worker = new WebDeliveryWorker({ store, transport });
  assert.deepEqual(await Promise.all([worker.runOnce(), worker.runOnce(), worker.runOnce()]), ['delivered', 'delivered', 'delivered']);
  assert.equal(store.attempts, 1);
});
