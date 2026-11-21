import { WebSocket } from 'ws';
import type { RelayTarget } from '../browser/relay.ts';
import { readProtectedFile } from '../config/config.ts';
import type { AttachProviderConfig } from '../config/schema.ts';
import { BrowserctlError } from '../errors.ts';

const PROTOCOL = 'browserctl.existing-browser.v1';
const APPROVAL_TIMEOUT_MS = 105_000;
const MAX_BYTES = 32 * 1024 * 1024;

export class AttachClient {
  readonly #provider: AttachProviderConfig;
  readonly #fetch: typeof fetch;

  constructor(provider: AttachProviderConfig, fetchImpl: typeof fetch = fetch) {
    this.#provider = provider;
    this.#fetch = fetchImpl;
  }

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${readProtectedFile(this.#provider.tokenFile, 'provider token')}` };
  }

  async status(): Promise<void> {
    const headers = this.#headers();
    const response = await this.#fetch(new URL('/v1/capabilities', this.#provider.attachUrl), {
      headers, redirect: 'error', signal: AbortSignal.timeout(3000),
    }).catch(() => { throw new BrowserctlError('provider_unreachable', 'the attach provider does not answer'); });
    try {
      if (!response.ok) throw refusal(response.status);
      const inventory = await response.json().catch(() => undefined);
      if (!inventory || inventory.protocol !== PROTOCOL || !Array.isArray(inventory.sources) ||
          inventory.sources.length !== 1 || inventory.sources[0] !== 'existing') {
        throw new BrowserctlError('provider_error', 'the attach provider sent invalid capabilities');
      }
    } finally {
      if (!response.bodyUsed) await response.body?.cancel().catch(() => undefined);
    }
  }

  open(client: string, signal?: AbortSignal): Promise<ExistingTarget> {
    if (signal?.aborted) return Promise.reject(canceled());
    const url = new URL('/v1/attach/existing', this.#provider.attachUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const headers = { ...this.#headers(), 'X-Browserctl-Client': client };
    return new Promise((resolve, reject) => {
      const upstream = new WebSocket(url, {
        headers, maxPayload: MAX_BYTES,
        perMessageDeflate: false, followRedirects: false,
      });
      const abort = () => {
        reject(canceled());
        upstream.terminate();
      };
      const removeAbort = () => signal?.removeEventListener('abort', abort);
      const timer = setTimeout(() => {
        reject(refusal(408));
        upstream.terminate();
      }, APPROVAL_TIMEOUT_MS);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      upstream.once('open', () => {
        clearTimeout(timer);
        removeAbort();
        resolve(new ExistingTarget(upstream));
      });
      upstream.once('close', () => {
        clearTimeout(timer);
        removeAbort();
        reject(refusal(0));
      });
      upstream.on('error', () => reject(refusal(0)));
      upstream.once('unexpected-response', (_request, response) => {
        reject(refusal(response.statusCode ?? 0));
        upstream.terminate();
      });
    });
  }
}

function canceled(): BrowserctlError {
  return new BrowserctlError('invalid_request', 'the attachment request was canceled');
}

function refusal(status: number): BrowserctlError {
  switch (status) {
    case 401: return new BrowserctlError('provider_unauthorized', 'the attach provider rejected its broker credential');
    case 403: return new BrowserctlError('unauthorized', 'the attachment was denied');
    case 408: return new BrowserctlError('timeout', 'the attachment approval expired');
    case 409: return new BrowserctlError('capacity', 'the attach provider already has a pending or active connection');
    case 0: return new BrowserctlError('provider_unreachable', 'the attach provider connection failed');
    default: return new BrowserctlError('provider_error', 'the attach provider could not connect to the browser');
  }
}

/** One approval, one upstream connection, one worker. Any disconnect ends the attachment. */
export class ExistingTarget implements RelayTarget {
  readonly #upstream: WebSocket;
  readonly lost: Promise<void>;
  #served = false;

  constructor(upstream: WebSocket) {
    this.#upstream = upstream;
    this.lost = new Promise((resolve) => upstream.once('close', () => resolve()));
  }

  async version(): Promise<Record<string, unknown>> {
    return {};
  }

  async stop(): Promise<void> {
    this.#upstream.terminate();
    await this.lost;
  }

  serve(socket: WebSocket, onTraffic: () => void): void {
    const upstream = this.#upstream;
    if (this.#served || upstream.readyState !== WebSocket.OPEN) {
      socket.close(1008, 'attachment unavailable');
      return;
    }
    this.#served = true;
    const send = (to: WebSocket, raw: Buffer) => {
      if (to.readyState !== WebSocket.OPEN || to.bufferedAmount + raw.length > MAX_BYTES) {
        upstream.terminate();
        socket.terminate();
        return;
      }
      to.send(raw, { binary: false }, (error) => { if (error) upstream.terminate(); });
    };
    socket.on('message', (data, binary) => {
      if (binary) { socket.terminate(); return; }
      const raw = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
      if (raw.length > MAX_BYTES) { socket.terminate(); return; }
      let command;
      try { command = JSON.parse(raw.toString()); } catch { socket.terminate(); return; }
      if (!command || !Number.isSafeInteger(command.id) || typeof command.method !== 'string') {
        socket.terminate();
        return;
      }
      onTraffic();
      if (command.method === 'Browser.close') {
        send(socket, Buffer.from(JSON.stringify({
          id: command.id, ...(typeof command.sessionId === 'string' && { sessionId: command.sessionId }),
          error: { code: -32000, message: 'An attached browser cannot be closed' },
        })));
        return;
      }
      send(upstream, raw);
    });
    upstream.on('message', (raw, binary) => {
      if (binary || !Buffer.isBuffer(raw)) { upstream.terminate(); return; }
      send(socket, raw);
    });
    upstream.once('close', () => socket.terminate());
    socket.once('close', () => upstream.terminate());
    socket.on('error', () => upstream.terminate());
  }
}
