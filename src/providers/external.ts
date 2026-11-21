// Sessions on external providers' browsers: a lease held for the session's life, and the relay's forwarding to the
// provider browser's debugging WebSocket, so session processes never connect to the provider's CDP host.

import { WebSocket, type RawData } from 'ws';
import type { ProviderConfig } from '../config/schema.ts';
import { BrowserctlError, errorClassOf } from '../errors.ts';
import type { RelayTarget } from '../browser/relay.ts';
import type { ExternalOpener, Session, SessionBrowser } from '../sessions/manager.ts';
import { emitEvent } from '../telemetry/signals.ts';
import { LeaseClient, type LeaseOperation, type ProviderInventory, type SlotStatus } from './lease-client.ts';
import { LEASE_EXPIRY_MS } from './sources.ts';

type BrowserEndpoint = { host: string } | (() => ReturnType<LeaseClient['privateBrowser']>);

export const HEARTBEAT_MS = 30_000;
const STATUS_POLL_MS = 30_000;
const VERSION_TIMEOUT_MS = 20_000;
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;

function failed(provider: string, operation: LeaseOperation, error: unknown): void {
  emitEvent('browserctl.lease.failed', { 'browserctl.provider': provider, 'browserctl.lease.operation': operation, 'error.type': errorClassOf(error) });
}

/** A provider browser's debugging endpoint, reached at the provider's CDP host. */
export class ExternalTarget implements RelayTarget {
  readonly #endpoint: BrowserEndpoint;

  static legacy(cdpHost: string, port: number): ExternalTarget {
    // Chrome answers DevTools HTTP only for an IP address or localhost in Host, so the host is an address.
    const host = cdpHost.includes(':') ? `[${cdpHost}]:${port}` : `${cdpHost}:${port}`;
    return new ExternalTarget({ host });
  }

  constructor(endpoint: BrowserEndpoint) {
    this.#endpoint = endpoint;
  }

  async #versionInfo(): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      const endpoint = this.#endpoint;
      const { base, headers } = typeof endpoint === 'function' ? endpoint() : { base: `http://${endpoint.host}/`, headers: undefined };
      response = await fetch(new URL('json/version', base), { headers, redirect: 'error', signal: AbortSignal.timeout(VERSION_TIMEOUT_MS) });
    } catch (error) {
      throw new BrowserctlError('provider_unreachable', 'the provider browser does not answer', { cause: error });
    }
    if (!response.ok) throw new BrowserctlError('provider_error', `the provider browser answered ${response.status}`);
    const version: unknown = await response.json().catch(() => undefined);
    if (typeof version !== 'object' || version === null || Array.isArray(version)) throw new BrowserctlError('provider_error', 'the provider browser sent invalid version information');
    return version as Record<string, unknown>;
  }

  async version(): Promise<Record<string, unknown>> {
    const { webSocketDebuggerUrl: _url, ...rest } = await this.#versionInfo();
    if (typeof this.#endpoint !== 'function') return rest;
    return Object.fromEntries(['Browser', 'Protocol-Version', 'User-Agent', 'V8-Version', 'WebKit-Version']
      .filter((key) => typeof rest[key] === 'string').map((key) => [key, rest[key]]));
  }

  /** The browser's debugging WebSocket, on the provider's CDP host whatever host the browser names. */
  socketUrl(): Promise<string> {
    if (typeof this.#endpoint === 'function') throw new BrowserctlError('invalid_request', 'private provider leases are not watchable');
    return this.#legacySocket(this.#endpoint.host);
  }

  async #legacySocket(host: string): Promise<string> {
    const named = (await this.#versionInfo()).webSocketDebuggerUrl;
    if (typeof named !== 'string') throw new BrowserctlError('provider_error', 'the provider browser names no debugging WebSocket');
    const path = new URL(named).pathname;
    if (!/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(path)) throw new BrowserctlError('provider_error', 'the provider browser names an unexpected WebSocket');
    return `ws://${host}${path}`;
  }

  serve(socket: WebSocket, onTraffic: () => void): void {
    // Messages keep their frame type: Chrome drops a connection that sends CDP in a binary frame.
    const pending: Array<{ raw: RawData; isBinary: boolean }> = [];
    let pendingBytes = 0;
    let upstream: WebSocket | undefined;
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      pending.length = 0;
      upstream?.close();
      if (socket.readyState === WebSocket.OPEN) socket.close(1001, 'browser closed');
    };
    socket.on('message', (raw, isBinary) => {
      onTraffic();
      if (closed) return;
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(raw, { binary: isBinary });
      else {
        pendingBytes += Array.isArray(raw) ? raw.reduce((sum, chunk) => sum + chunk.byteLength, 0) : raw.byteLength;
        if (pendingBytes > MAX_PENDING_BYTES || pending.length >= 64) finish();
        else pending.push({ raw, isBinary });
      }
    });
    socket.on('close', finish);
    socket.on('error', finish);
    const upstreamAddress = async () => {
      if (typeof this.#endpoint !== 'function') return { url: await this.#legacySocket(this.#endpoint.host), headers: undefined };
      const endpoint = this.#endpoint();
      const url = new URL('devtools/browser', endpoint.base);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return { url: url.href, headers: endpoint.headers };
    };
    upstreamAddress().then(
      ({ url, headers }) => {
        if (closed) return;
        upstream = new WebSocket(url, { headers, handshakeTimeout: VERSION_TIMEOUT_MS, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false, followRedirects: false });
        upstream.on('open', () => {
          for (const { raw, isBinary } of pending.splice(0)) upstream!.send(raw, { binary: isBinary });
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
  leaseExpiryMs?: number;
  statusPollMs?: number;
  /** Called when a provider forgets a session's lease; the session must end. */
  onLeaseLost: (session: Session) => void;
}

/** The configured external providers: their lease clients, the sessions' leases, and the status of each provider. */
export class Providers {
  readonly #clients = new Map<string, LeaseClient>();
  readonly #options: ProvidersOptions;
  readonly #state = new Map<string, ProviderState>();
  readonly #inventory = new Map<string, ProviderInventory>();
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

  inventory(name: string): ProviderInventory {
    const inventory = this.#inventory.get(name);
    return { sources: [...(inventory?.sources ?? [])], profiles: [...(inventory?.profiles ?? [])] };
  }

  /** Lease a browser for a session, start it, and hold the lease while the session lives. */
  readonly opener: ExternalOpener = async (session) => {
    if (session.source.kind !== 'provider') throw new BrowserctlError('internal', 'not a provider session');
    const name = session.source.provider;
    const client = this.#clients.get(name);
    if (!client) throw new BrowserctlError('not_found', `no provider ${name}`);
    const source = session.source.browserSource;
    const cdpHost = client.provider.cdpHost;
    if (!source && !cdpHost) throw new BrowserctlError('invalid_request', `provider ${name} requires an explicit source`);
    if (source) {
      const state = this.#state.get(name)!;
      if (!state.reachable) throw new BrowserctlError('provider_unreachable', `provider ${name} is unavailable`);
      const inventory = this.inventory(name);
      if (!inventory.sources.includes(source.type)) throw new BrowserctlError('invalid_request', `provider ${name} does not offer ${source.type} sessions`);
      if (source.type === 'profile' && !inventory.profiles.includes(source.name)) throw new BrowserctlError('not_found', `provider ${name} does not offer that profile`);
    }
    const lease = await client.lease(`browserctl ${session.client} ${session.id}`, session.source.slot, source).catch((error: unknown) => {
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
      let target: ExternalTarget;
      if (source) {
        await client.ensurePrivate(lease.lease);
        target = new ExternalTarget(() => client.privateBrowser(lease.lease));
      } else {
        const ensured = await client.ensure(lease.lease);
        if (ensured.slot !== lease.slot) throw new BrowserctlError('provider_error', 'the provider did not start the leased slot');
        target = ExternalTarget.legacy(cdpHost!, ensured.port);
      }
      await target.version();
      let confirmed = Date.now();
      const expiryMs = this.#options.leaseExpiryMs ?? LEASE_EXPIRY_MS;
      heartbeat = setInterval(() => {
        client.heartbeat(lease.lease).then(
          () => {
            confirmed = Date.now();
          },
          (error) => {
            failed(name, 'heartbeat', error);
            // A 404, or failures until the provider's expiry has passed, mean the slot may now be someone else's.
            if (released || (errorClassOf(error) !== 'lease_lost' && Date.now() - confirmed < expiryMs)) return;
            released = true;
            clearInterval(heartbeat);
            own.delete(lease.slot);
            this.#options.onLeaseLost(session);
          },
        );
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
          const { slots, inventory } = await client.status();
          this.#inventory.set(name, inventory);
          const own = this.#own.get(name)!;
          Object.assign(state, { reachable: true, error: undefined, slots: client.provider.cdpHost ? slots.map((slot) => ({ ...slot, own: own.has(slot.slot) })) : [] });
        } catch (error) {
          this.#inventory.delete(name);
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
    return client?.provider.cdpHost && entry ? ExternalTarget.legacy(client.provider.cdpHost, entry.port) : undefined;
  }
}
