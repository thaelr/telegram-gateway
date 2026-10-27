import { randomUUID } from 'node:crypto';
import type { WebDeliveryEvent } from './types.js';

export type WebDeliveryClaim = { event: WebDeliveryEvent; attempts: number; leaseToken: string };
export type WebDeliveryFailure = { code: string; retryAt: Date | null; terminal: boolean };
export interface WebDeliveryStore {
  /** Atomically claim one due row, increment its persisted attempts, and replace its lease token. */
  claimNext(input: { leaseToken: string; leaseMs: number; maxAttempts: number; now: Date }): Promise<WebDeliveryClaim | null>;
  /** Both settlement methods must compare the current lease token in the same SQL UPDATE. */
  settleDelivered(eventId: string, leaseToken: string, now: Date): Promise<void>;
  settleFailure(eventId: string, leaseToken: string, failure: WebDeliveryFailure, now: Date): Promise<void>;
}

export class WebDeliveryError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) { super(code); }
}
export interface WebDeliveryTransport {
  readonly timeoutMs: number;
  send(event: WebDeliveryEvent, signal?: AbortSignal): Promise<void>;
}
export type WebDeliveryTransportOptions = {
  url: string;
  secret: string;
  headerName?: string;
  timeoutMs?: number;
  /** Only for a local test receiver. Non-loopback HTTP remains forbidden. */
  allowLoopbackHttp?: boolean;
  fetchImpl?: typeof fetch;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}

/** Reconstruct the public DTO; never serialize credentials or accidental extra row fields. */
function wireEvent(event: WebDeliveryEvent): WebDeliveryEvent {
  if (event.source !== 'web' || !['scene_start', 'message', 'reset'].includes(event.action)
      || !['fast', 'roleplay'].includes(event.scene_mode)
      || typeof event.event_id !== 'string' || !event.event_id
      || typeof event.user_id !== 'string' || !event.user_id
      || !Number.isSafeInteger(event.chat_id) || event.chat_id < 1
      || !Number.isSafeInteger(event.character_i) || event.character_i < 1
      || typeof event.data?.client_message_id !== 'string' || !event.data.client_message_id
      || (event.action === 'message' && (typeof event.data.user_message !== 'string' || !event.data.user_message.trim()))) {
    throw new WebDeliveryError('invalid_event', false);
  }
  return {
    event_id: event.event_id, user_id: event.user_id, chat_id: event.chat_id,
    character_i: event.character_i, scene_mode: event.scene_mode, source: 'web', action: event.action,
    data: { client_message_id: event.data.client_message_id,
      ...(event.action === 'message' ? { user_message: event.data.user_message } : {}),
      ...(event.action === 'reset' && event.data.entry_mode === 'fast_scene_skip' && event.data.payment_token
        ? { entry_mode: 'fast_scene_skip' as const, payment_token: event.data.payment_token, feature_key: 'fast_scene_skip' as const } : {}) },
  };
}

async function acknowledgement(response: Response): Promise<unknown> {
  if (!response.body) throw new WebDeliveryError('invalid_acknowledgement', true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) {
        await reader.cancel();
        throw new WebDeliveryError('invalid_acknowledgement', true);
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof WebDeliveryError) throw error;
    throw new WebDeliveryError('invalid_acknowledgement', true);
  } finally {
    reader.releaseLock();
  }
}

export function createWebDeliveryTransport(options: WebDeliveryTransportOptions): WebDeliveryTransport {
  let endpoint: URL;
  try { endpoint = new URL(options.url); } catch { throw new Error('Invalid Web webhook URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(options.allowLoopbackHttp && loopback && endpoint.protocol === 'http:')) {
    throw new Error('Web webhook must use HTTPS');
  }
  if (endpoint.username || endpoint.password || endpoint.hash) throw new Error('Invalid Web webhook URL');
  const headerName = options.headerName ?? 'x-web-event-secret';
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(headerName)
      || ['content-type', 'content-length', 'host', 'connection'].includes(headerName.toLowerCase())) {
    throw new Error('Invalid Web webhook secret header');
  }
  if (!options.secret || /[\r\n]/.test(options.secret)) throw new Error('Web webhook secret is required');
  const timeoutMs = positiveInteger(options.timeoutMs ?? 10_000, 'Web webhook timeout');
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    timeoutMs,
    async send(event, signal) {
      const body = JSON.stringify(wireEvent(event));
      const controller = new AbortController();
      let timedOut = false;
      const interrupt = () => controller.abort();
      if (signal?.aborted) controller.abort();
      signal?.addEventListener('abort', interrupt, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      timer.unref();
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json', [headerName]: options.secret },
          body, signal: controller.signal, redirect: 'manual',
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new WebDeliveryError(`http_${response.status}`,
            response.status >= 500 || [408, 425, 429].includes(response.status));
        }
        const ack = await acknowledgement(response);
        if (!ack || typeof ack !== 'object' || !('accepted' in ack) || ack.accepted !== true
            || !('event_id' in ack) || ack.event_id !== event.event_id) {
          throw new WebDeliveryError('invalid_acknowledgement', true);
        }
      } catch (error) {
        if (timedOut) throw new WebDeliveryError('delivery_timeout', true);
        if (signal?.aborted) throw new WebDeliveryError('delivery_interrupted', true);
        if (error instanceof WebDeliveryError) throw error;
        throw new WebDeliveryError('delivery_network_error', true);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', interrupt);
      }
    },
  };
}

export type DeliveryRunResult = 'idle' | 'delivered' | 'retry' | 'failed';
export type WebDeliveryWorkerOptions = {
  store: WebDeliveryStore;
  transport: WebDeliveryTransport;
  maxAttempts?: number;
  leaseMs?: number;
  pollMs?: number;
  now?: () => Date;
  /** Receive only a fixed diagnostic code, never an external error or secret. */
  onError?: (code: 'delivery_store_error') => void;
};

export class WebDeliveryWorker {
  private readonly maxAttempts: number;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly now: () => Date;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<DeliveryRunResult> | null = null;
  private controller: AbortController | null = null;

  constructor(private readonly options: WebDeliveryWorkerOptions) {
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 5, 'delivery max attempts');
    this.leaseMs = positiveInteger(options.leaseMs ?? 30_000, 'delivery lease');
    this.pollMs = positiveInteger(options.pollMs ?? 1_000, 'delivery polling interval');
    if (this.leaseMs <= options.transport.timeoutMs + 1_000) throw new Error('Delivery lease must exceed request timeout');
    this.now = options.now ?? (() => new Date());
  }

  runOnce(): Promise<DeliveryRunResult> {
    if (this.active) return this.active;
    this.controller = new AbortController();
    this.active = this.deliverOne(this.controller.signal).finally(() => { this.active = null; this.controller = null; });
    return this.active;
  }

  private async deliverOne(signal: AbortSignal): Promise<DeliveryRunResult> {
    const claim = await this.options.store.claimNext({ leaseToken: randomUUID(), leaseMs: this.leaseMs,
      maxAttempts: this.maxAttempts, now: this.now() });
    if (!claim) return 'idle';
    try {
      await this.options.transport.send(claim.event, signal);
    } catch (error) {
      const failure = error instanceof WebDeliveryError ? error : new WebDeliveryError('delivery_network_error', true);
      const terminal = !failure.retryable || claim.attempts >= this.maxAttempts;
      const now = this.now();
      const retryAt = terminal ? null : new Date(now.getTime() + Math.min(60_000, 1_000 * (2 ** Math.max(0, claim.attempts - 1))));
      await this.options.store.settleFailure(claim.event.event_id, claim.leaseToken,
        { code: failure.code, retryAt, terminal }, now);
      return terminal ? 'failed' : 'retry';
    }
    // If acknowledgement settlement fails, the durable lease expires and retries the same event.
    // Never convert a failed DB settlement into a new delivery or a completed engine operation.
    await this.options.store.settleDelivered(claim.event.event_id, claim.leaseToken, this.now());
    return 'delivered';
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try { await this.runOnce(); } catch { this.options.onError?.('delivery_store_error'); }
      if (this.running) {
        this.timer = setTimeout(() => { void tick(); }, this.pollMs);
        this.timer.unref();
      }
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.controller?.abort();
    try { await this.active; } catch { this.options.onError?.('delivery_store_error'); }
  }
}
