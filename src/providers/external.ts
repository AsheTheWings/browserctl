// Sessions on external providers' browsers: a lease held for the session's life, and the relay's forwarding to the
// provider browser's debugging WebSocket, so session processes never connect to the provider's CDP host.

import { WebSocket, type RawData } from 'ws';
import type { ProviderConfig } from '../config/schema.ts';
import { BrowserctlError, errorClassOf } from '../errors.ts';
import type { DisplayBrowser, RecordingBrowser, WindowBrowser } from '../browser/display.ts';
import type { RelayTarget } from '../browser/relay.ts';
import { packRevision } from '../profiles/archive.ts';
import type { ProfileStore } from '../profiles/store.ts';
import type { ExternalOpener, Session, SessionBrowser } from '../sessions/manager.ts';
import { emitEvent, inSpan } from '../telemetry/signals.ts';
import { LeaseClient, type LeaseOperation, type ManagedLeaseMode, type ManagedLeaseSource, type ManagedRuntimeCapabilities, type ProviderInventory, type SlotStatus } from './lease-client.ts';
import { LEASE_EXPIRY_MS } from './sources.ts';
import { AttachClient } from './attach-client.ts';
import type { BrowserSource } from './sources.ts';

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
  description?: string;
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
  /** Host profile store for compatible managed-runtime providers. */
  profiles?: ProfileStore;
  /** Local runtime compatibility check (platform and Chrome major version). */
  runtime?: { platform: string; chromeMajor?: number };
  /** Called when a provider forgets a session's lease; the session must end. */
  onLeaseLost: (session: Session) => void;
}

/** The configured external providers: their lease clients, the sessions' leases, and the status of each provider. */
export class Providers {
  readonly #clients = new Map<string, LeaseClient>();
  readonly #attach = new Map<string, AttachClient>();
  readonly #options: ProvidersOptions;
  readonly #state = new Map<string, ProviderState>();
  readonly #inventory = new Map<string, Omit<ProviderInventory, 'sources'> & { sources: BrowserSource['type'][] }>();
  /** Slots this server's sessions hold, by provider. */
  readonly #own = new Map<string, Set<number>>();
  #poller: NodeJS.Timeout | undefined;

  constructor(providers: ProviderConfig[], options: ProvidersOptions, fetchImpl?: typeof fetch) {
    this.#options = options;
    for (const provider of providers) {
      if (provider.attachUrl !== undefined) this.#attach.set(provider.name, new AttachClient(provider, fetchImpl));
      else this.#clients.set(provider.name, new LeaseClient(provider, fetchImpl));
      this.#own.set(provider.name, new Set());
      const { name, description } = provider;
      this.#state.set(name, { name, ...(description !== undefined && { description }),
        reachable: false, error: undefined, checkedAt: undefined, slots: [] });
    }
  }

  get names(): string[] {
    return [...this.#state.keys()];
  }

  inventory(name: string): Omit<ProviderInventory, 'sources'> & { sources: BrowserSource['type'][] } {
    const inventory = this.#inventory.get(name);
    const managedRuntime = this.managedRuntime(name);
    return {
      sources: [...(inventory?.sources ?? [])], profiles: [...(inventory?.profiles ?? [])],
      ...(managedRuntime && { managedRuntime }),
    };
  }

  /** Whether a configured external provider opted into managed-runtime parity. */
  isManagedRuntimeConfigured(name: string): boolean {
    return this.#clients.get(name)?.provider.managedRuntime === true;
  }

  /** Managed-runtime compatibility status for a provider: null if not opted in. */
  managedRuntimeState(name: string): 'ready' | 'unavailable' | 'incompatible' | null {
    if (!this.isManagedRuntimeConfigured(name)) return null;
    if (!this.#state.get(name)?.reachable) return 'unavailable';
    return this.managedRuntime(name) ? 'ready' : 'incompatible';
  }

  /** Compatible managed-runtime capabilities for a reachable opted-in provider, or undefined. */
  managedRuntime(name: string): ManagedRuntimeCapabilities | undefined {
    const state = this.#state.get(name);
    const capabilities = this.#inventory.get(name)?.managedRuntime;
    if (!state?.reachable || !capabilities) return undefined;
    const expectedPlatform = this.#options.runtime?.platform ?? `${process.platform}-${process.arch}`;
    if (capabilities.platform !== expectedPlatform) return undefined;
    const expectedMajor = this.#options.runtime?.chromeMajor;
    if (expectedMajor !== undefined && capabilities.chromeMajor !== expectedMajor) return undefined;
    return capabilities;
  }

  /** Lease a browser for a session, start it, and hold the lease while the session lives. */
  readonly opener: ExternalOpener = async (session, signal) => {
    if (session.source.kind !== 'provider') {
      const name = session.source.runtime;
      if (!name) throw new BrowserctlError('internal', 'not a provider session');
      const client = this.#clients.get(name);
      if (!client) throw new BrowserctlError('not_found', `no provider ${name}`);
      if (!client.provider.managedRuntime) {
        throw new BrowserctlError('invalid_request', `provider ${name} is not configured as a managed runtime`);
      }
      return this.#openManagedRuntime(client, session, name, session.source);
    }
    const name = session.source.provider;
    const source = session.source.browserSource;
    const attach = this.#attach.get(name);
    if (attach) {
      if (source?.type !== 'existing' || session.source.slot !== undefined || session.purpose !== 'agent') {
        throw new BrowserctlError('invalid_request', `provider ${name} only accepts an explicit existing source`);
      }
      const target = await inSpan('browserctl.provider.attach', { 'browserctl.provider': name },
        () => attach.open(session.client, signal));
      void target.lost.then(() => this.#options.onLeaseLost(session));
      return { target, browser: { cdp: undefined, pid: undefined, exit: async () => false, stop: () => target.stop() } };
    }
    const client = this.#clients.get(name);
    if (!client) throw new BrowserctlError('not_found', `no provider ${name}`);
    if (source?.type === 'existing') throw new BrowserctlError('invalid_request', `provider ${name} does not offer existing sessions`);
    if (client.provider.managedRuntime) {
      throw new BrowserctlError('invalid_request', `provider ${name} requires an explicit ephemeral or profile source`);
    }
    if (session.purpose === 'sign_in') throw new BrowserctlError('invalid_request', `provider ${name} does not support host-managed sign-in sessions`);
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

  async #openManagedRuntime(
    client: LeaseClient,
    session: Session,
    name: string,
    source: { kind: 'profile'; profile: string; runtime?: string; slot?: number } | { kind: 'ephemeral'; runtime?: string; slot?: number },
  ): Promise<{ browser: SessionBrowser; target: RelayTarget | undefined }> {
    const state = this.#state.get(name)!;
    if (!state.reachable) throw new BrowserctlError('provider_unreachable', `provider ${name} is unavailable`);
    const runtime = this.managedRuntime(name);
    if (!runtime) throw new BrowserctlError('provider_error', `provider ${name} is not compatible with this server runtime`);
    const sourceType = source.kind;
    const inventory = this.inventory(name);
    if (!inventory.sources.includes(sourceType)) throw new BrowserctlError('invalid_request', `provider ${name} does not offer ${sourceType} sessions`);
    const mode: ManagedLeaseMode = session.purpose === 'sign_in' ? 'sign_in' : session.purpose === 'check' ? 'check' : 'agent';
    if (mode === 'sign_in' && runtime.signIn !== 'vnc') {
      throw new BrowserctlError('invalid_request', `provider ${name} does not support interactive VNC sign-in`);
    }

    let archiveSource: ManagedLeaseSource = { type: 'ephemeral' };
    if (source.kind === 'profile') {
      const profiles = this.#options.profiles;
      if (!profiles) throw new BrowserctlError('internal', 'profile store is unavailable');
      const profile = await profiles.get(source.profile);
      session.revision = profile.current;
      const packed = await packRevision(profiles.revisionPath(source.profile, profile.current));
      if (packed) {
        if (!(await client.hasRevision(packed.sha256))) {
          await client.putRevision(packed.sha256, packed.archive);
        }
        archiveSource = { type: 'archive', sha256: packed.sha256 };
      } else {
        archiveSource = { type: 'archive' };
      }
    }

    const lease = await client.leaseManaged(`browserctl ${session.client} ${session.id}`, mode, archiveSource, source.slot).catch((error: unknown) => {
      failed(name, 'lease', error);
      throw error;
    });
    const own = this.#own.get(name)!;
    own.add(lease.slot);
    let heartbeat: NodeJS.Timeout | undefined;
    let released = false;
    let saving = false;
    const release = async () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      own.delete(lease.slot);
      await client.release(lease.lease).catch((error) => failed(name, 'release', error));
    };
    try {
      await client.ensureManaged(lease.lease, mode);
      let target: ExternalTarget | undefined;
      if (mode !== 'sign_in') {
        target = new ExternalTarget(() => client.privateBrowser(lease.lease));
        await target.version();
      }
      let confirmed = Date.now();
      const expiryMs = this.#options.leaseExpiryMs ?? LEASE_EXPIRY_MS;
      heartbeat = setInterval(() => {
        if (released || saving) return;
        client.heartbeat(lease.lease).then(
          () => { confirmed = Date.now(); },
          (error) => {
            if (released || saving) return;
            failed(name, 'heartbeat', error);
            if (errorClassOf(error) !== 'lease_lost' && Date.now() - confirmed < expiryMs) return;
            released = true;
            clearInterval(heartbeat);
            own.delete(lease.slot);
            this.#options.onLeaseLost(session);
          },
        );
      }, this.#options.heartbeatMs ?? HEARTBEAT_MS);
      heartbeat.unref();

      const base: SessionBrowser = {
        cdp: undefined,
        pid: undefined,
        exit: async () => true,
        stop: release,
      };
      if (mode === 'sign_in') {
        const display: DisplayBrowser = {
          ...base,
          vncRemote: () => client.vncRemote(lease.lease),
          saveArchive: async (timeoutMs) => {
            saving = true;
            clearInterval(heartbeat);
            const saved = await client.saveSignIn(lease.lease, Math.max(timeoutMs + 30_000, 90_000));
            // Remote save releases the remote lease on success.
            released = true;
            own.delete(lease.slot);
            return saved;
          },
        };
        return { browser: display, target: undefined };
      }
      const browser: SessionBrowser & Partial<WindowBrowser> & Partial<RecordingBrowser> = {
        ...base,
        ...(mode === 'agent' && runtime.views.includes('window') && { captureWindow: () => client.windowStream(lease.lease) }),
        ...(runtime.recording === 'mp4' && { captureRecording: () => client.recordingStream(lease.lease) }),
      };
      return { browser, target };
    } catch (error) {
      failed(name, 'ensure', error);
      await release();
      throw error;
    }
  }

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
    await Promise.all(this.names.map(async (name) => {
        const state = this.#state.get(name)!;
        state.checkedAt = new Date().toISOString();
        try {
          const attach = this.#attach.get(name);
          if (attach) {
            await attach.status();
            this.#inventory.set(name, { sources: ['existing'], profiles: [] });
            Object.assign(state, { reachable: true, error: undefined, slots: [] });
            return;
          }
          const client = this.#clients.get(name)!;
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
