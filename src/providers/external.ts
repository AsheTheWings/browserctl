// Sessions on external providers' browsers: a lease held for the session's life, and the relay's forwarding to the
// provider browser's debugging WebSocket, so session processes never connect to the provider's CDP host.

import { WebSocket, type RawData } from 'ws';
import type { ProviderConfig } from '../config/schema.ts';
import { BrowserctlError, errorClassOf } from '../errors.ts';
import type { RelayTarget } from '../browser/relay.ts';
import type { ExternalOpener, Session, SessionBrowser } from '../sessions/manager.ts';
import { emitEvent } from '../telemetry/signals.ts';
import { LeaseClient, type LeaseOperation, type SlotStatus } from './lease-client.ts';

export const HEARTBEAT_MS = 30_000;
const STATUS_POLL_MS = 30_000;
const VERSION_TIMEOUT_MS = 20_000;
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

function failed(provider: string, operation: LeaseOperation, error: unknown): void {
  emitEvent('browserctl.lease.failed', { 'browserctl.provider': provider, 'browserctl.lease.operation': operation, 'error.type': errorClassOf(error) });
}

/** A provider browser's debugging endpoint, reached at the provider's CDP host. */
export class ExternalTarget implements RelayTarget {
  readonly #base: string;
  readonly #host: string;

  constructor(cdpHost: string, port: number) {
    // Chrome answers DevTools HTTP only for an IP address or localhost in Host, so the host is an address.
    this.#host = cdpHost.includes(':') ? `[${cdpHost}]:${port}` : `${cdpHost}:${port}`;
    this.#base = `http://${this.#host}`;
  }

  async #versionInfo(): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`${this.#base}/json/version`, { redirect: 'error', signal: AbortSignal.timeout(VERSION_TIMEOUT_MS) });
    } catch (error) {
      throw new BrowserctlError('provider_unreachable', 'the provider browser does not answer', { cause: error });
    }
    if (!response.ok) throw new BrowserctlError('provider_error', `the provider browser answered ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  async version(): Promise<Record<string, unknown>> {
    const { webSocketDebuggerUrl: _url, ...rest } = await this.#versionInfo();
    return rest;
  }

  /** The browser's debugging WebSocket, on the provider's CDP host whatever host the browser names. */
  async socketUrl(): Promise<string> {
    const named = (await this.#versionInfo()).webSocketDebuggerUrl;
    if (typeof named !== 'string') throw new BrowserctlError('provider_error', 'the provider browser names no debugging WebSocket');
    const path = new URL(named).pathname;
    if (!/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(path)) throw new BrowserctlError('provider_error', 'the provider browser names an unexpected WebSocket');
    return `ws://${this.#host}${path}`;
  }

  serve(socket: WebSocket, onTraffic: () => void): void {
    const pending: RawData[] = [];
    let upstream: WebSocket | undefined;
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      upstream?.close();
      if (socket.readyState === WebSocket.OPEN) socket.close(1001, 'browser closed');
    };
    socket.on('message', (raw, isBinary) => {
      onTraffic();
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(raw, { binary: isBinary });
      else pending.push(raw);
    });
    socket.on('close', finish);
    socket.on('error', finish);
    this.socketUrl().then(
      (url) => {
        if (closed) return;
        upstream = new WebSocket(url, { maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false, followRedirects: false });
        upstream.on('open', () => {
          for (const raw of pending.splice(0)) upstream!.send(raw);
        });
        upstream.on('message', (raw, isBinary) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(raw, { binary: isBinary });
        });
        upstream.on('close', finish);
        upstream.on('error', finish);
      },
      finish,
    );
  }
}

export interface ProviderState {
  name: string;
  reachable: boolean;
  /** The error class of the last failed status poll. */
  error: string | undefined;
  checkedAt: string | undefined;
  /** Leased slots; own marks the ones this server's sessions hold. */
  slots: Array<SlotStatus & { own: boolean }>;
}

export interface ProvidersOptions {
  heartbeatMs?: number;
  statusPollMs?: number;
  /** Called when a provider forgets a session's lease; the session must end. */
  onLeaseLost: (session: Session) => void;
}

/** The configured external providers: their lease clients, the sessions' leases, and the status of each provider. */
export class Providers {
  readonly #clients = new Map<string, LeaseClient>();
  readonly #options: ProvidersOptions;
  readonly #state = new Map<string, ProviderState>();
  /** Slots this server's sessions hold, by provider. */
  readonly #own = new Map<string, Set<number>>();
  #poller: NodeJS.Timeout | undefined;

  constructor(providers: ProviderConfig[], options: ProvidersOptions, fetchImpl?: typeof fetch) {
    this.#options = options;
    for (const provider of providers) {
      this.#clients.set(provider.name, new LeaseClient(provider, fetchImpl));
      this.#own.set(provider.name, new Set());
      this.#state.set(provider.name, { name: provider.name, reachable: false, error: undefined, checkedAt: undefined, slots: [] });
    }
  }

  get names(): string[] {
    return [...this.#clients.keys()];
  }

  /** Lease a browser for a session, start it, and hold the lease while the session lives. */
  readonly opener: ExternalOpener = async (session) => {
    if (session.source.kind !== 'provider') throw new BrowserctlError('internal', 'not a provider session');
    const name = session.source.provider;
    const client = this.#clients.get(name);
    if (!client) throw new BrowserctlError('not_found', `no provider ${name}`);
    const lease = await client.lease(`browserctl ${session.client} ${session.id}`, session.source.slot).catch((error: unknown) => {
      failed(name, 'lease', error);
      throw error;
    });
    const own = this.#own.get(name)!;
    own.add(lease.slot);
    let heartbeat: NodeJS.Timeout | undefined;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      own.delete(lease.slot);
      await client.release(lease.lease).catch((error) => failed(name, 'release', error));
    };
    try {
      const ensured = await client.ensure(lease.lease);
      const target = new ExternalTarget(client.provider.cdpHost, ensured.port);
      await target.version();
      heartbeat = setInterval(() => {
        client.heartbeat(lease.lease).catch((error) => {
          failed(name, 'heartbeat', error);
          if (errorClassOf(error) === 'lease_lost') {
            released = true;
            clearInterval(heartbeat);
            own.delete(lease.slot);
            this.#options.onLeaseLost(session);
          }
        });
      }, this.#options.heartbeatMs ?? HEARTBEAT_MS);
      heartbeat.unref();
      const browser: SessionBrowser = { cdp: undefined, pid: undefined, exit: async () => true, stop: release };
      return { browser, target };
    } catch (error) {
      failed(name, 'ensure', error);
      await release();
      throw error;
    }
  };

  /** Poll every provider's status now and then on an interval. */
  start(): void {
    void this.poll();
    this.#poller = setInterval(() => void this.poll(), this.#options.statusPollMs ?? STATUS_POLL_MS);
    this.#poller.unref();
  }

  stop(): void {
    clearInterval(this.#poller);
  }

  async poll(): Promise<void> {
    await Promise.all(
      [...this.#clients.entries()].map(async ([name, client]) => {
        const state = this.#state.get(name)!;
        state.checkedAt = new Date().toISOString();
        try {
          const slots = await client.status();
          const own = this.#own.get(name)!;
          Object.assign(state, { reachable: true, error: undefined, slots: slots.map((slot) => ({ ...slot, own: own.has(slot.slot) })) });
        } catch (error) {
          Object.assign(state, { reachable: false, error: errorClassOf(error), slots: [] });
        }
      }),
    );
  }

  /** Each provider's last known status. */
  states(): ProviderState[] {
    return [...this.#state.values()].map((state) => ({ ...state, slots: state.slots.map((slot) => ({ ...slot })) }));
  }

  /** A browser another owner leased, for watching it read-only; undefined unless the last poll listed it. */
  watchTarget(provider: string, slot: number): ExternalTarget | undefined {
    const client = this.#clients.get(provider);
    const entry = this.#state.get(provider)?.slots.find((candidate) => candidate.slot === slot && !candidate.own);
    return client && entry ? new ExternalTarget(client.provider.cdpHost, entry.port) : undefined;
  }
}
