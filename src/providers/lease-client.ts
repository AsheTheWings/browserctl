// The client of an external provider's lease API, as docs/lease-protocol.md defines it. Each failure maps to a
// stable error class: a full provider to capacity, a refused token to provider_unauthorized, no answer to
// provider_unreachable, an unknown lease to lease_lost, and anything else to provider_error.

import { PassThrough } from 'node:stream';
import { readProtectedFile } from '../config/config.ts';
import type { LeaseProviderConfig } from '../config/schema.ts';
import type { WindowStream } from '../browser/display.ts';
import { BrowserctlError } from '../errors.ts';
import { MAX_ARCHIVE_BYTES } from '../profiles/archive.ts';
import { inSpan } from '../telemetry/signals.ts';
import { parseCapacity, PROFILE_NAME, SOURCE_TYPES, supportsPrivateLeases, type LeaseSource, type ProviderCapacity } from './sources.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const RUNTIME_PLATFORM = /^[a-z0-9]+-[a-z0-9_]+$/;
const RUNTIME_VIEWS = ['screencast', 'window'] as const;

export type LeaseOperation = 'lease' | 'ensure' | 'heartbeat' | 'release' | 'status' | 'save' | 'revision_check' | 'revision_upload';

export interface ManagedRuntimeCapabilities {
  version: 1;
  platform: string;
  chromeMajor: number;
  views: Array<'screencast' | 'window'>;
  signIn?: 'vnc';
  recording?: 'mp4';
}

export type ManagedLeaseMode = 'agent' | 'sign_in' | 'check';
export type ManagedLeaseSource = { type: 'ephemeral' } | { type: 'archive'; sha256?: string };

export interface Lease {
  lease: string;
  slot: number;
}

export interface SlotStatus {
  slot: number;
  port: number;
  owner: string;
  running: boolean;
  idleMs: number;
}

export interface ProviderInventory {
  sources: LeaseSource['type'][];
  profiles: string[];
  managedRuntime?: ManagedRuntimeCapabilities;
}

export class LeaseClient {
  readonly provider: LeaseProviderConfig;
  readonly #fetch: typeof fetch;

  constructor(provider: LeaseProviderConfig, fetchImpl: typeof fetch = fetch) {
    this.provider = provider;
    this.#fetch = fetchImpl;
  }

  async lease(owner: string, slot?: number, source?: LeaseSource): Promise<Lease> {
    const body = await this.#request('lease', 'POST', '/leases', { owner, ...(slot !== undefined && { slot }), ...(source && { source }) });
    const lease = { lease: text(body.lease, 'lease'), slot: integer(body.slot, 'slot') };
    if (source && (body.cdp !== 'lease' || body.port !== undefined || body.source?.type !== source.type || (source.type === 'profile' && body.source.name !== source.name))) {
      await this.release(lease.lease).catch(() => undefined);
      throw malformed();
    }
    if (!source && (body.cdp === 'lease' || !Number.isSafeInteger(body.port) || body.port < 1 || body.port > 65535)) {
      await this.release(lease.lease).catch(() => undefined);
      throw malformed();
    }
    return lease;
  }

  async ensure(id: string): Promise<{ slot: number; port: number }> {
    const body = await this.#request('ensure', 'POST', `/leases/${encodeURIComponent(id)}/ensure`);
    if (body.cdp === 'lease') throw malformed();
    return { slot: integer(body.slot, 'slot'), port: port(body.port) };
  }

  async ensurePrivate(id: string): Promise<void> {
    const body = await this.#request('ensure', 'POST', `/leases/${encodeURIComponent(id)}/ensure`);
    if (body.cdp !== 'lease' || body.port !== undefined) throw malformed();
  }

  privateBrowser(id: string): { base: URL; headers: { authorization: string } } {
    const prefix = this.provider.leaseUrl.replace(/\/+$/, '');
    return { base: new URL(`${prefix}/leases/${encodeURIComponent(id)}/cdp/`), headers: { authorization: `Bearer ${this.#token()}` } };
  }

  async heartbeat(id: string): Promise<void> {
    await this.#request('heartbeat', 'POST', `/leases/${encodeURIComponent(id)}/heartbeat`);
  }

  async release(id: string): Promise<void> {
    await this.#request('release', 'DELETE', `/leases/${encodeURIComponent(id)}`);
  }

  async hasRevision(sha256: string): Promise<boolean> {
    if (!SHA256_HEX.test(sha256)) throw new BrowserctlError('invalid_request', 'invalid revision digest');
    const response = await this.#raw('revision_check', 'HEAD', `/revisions/${sha256}`, undefined, { 'x-revision-sha256': sha256 });
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    throw new BrowserctlError('provider_error', `provider ${this.provider.name} answered ${response.status}`);
  }

  async putRevision(sha256: string, archive: Buffer): Promise<void> {
    if (!SHA256_HEX.test(sha256)) throw new BrowserctlError('invalid_request', 'invalid revision digest');
    const response = await this.#raw('revision_upload', 'PUT', `/revisions/${sha256}`, archive, {
      'content-type': 'application/gzip',
      'x-revision-sha256': sha256,
    }, 90_000);
    if (!response.ok) throw new BrowserctlError('provider_error', `provider ${this.provider.name} answered ${response.status}`);
  }

  async leaseManaged(owner: string, mode: ManagedLeaseMode, source: ManagedLeaseSource, slot?: number): Promise<Lease> {
    const body = await this.#request('lease', 'POST', '/leases', {
      owner, mode, source, ...(slot !== undefined && { slot }),
    });
    const lease = { lease: text(body.lease, 'lease'), slot: integer(body.slot, 'slot') };
    if (body.cdp !== 'lease' || body.port !== undefined) {
      await this.release(lease.lease).catch(() => undefined);
      throw malformed();
    }
    return lease;
  }

  async ensureManaged(id: string, mode: ManagedLeaseMode): Promise<void> {
    const body = await this.#request('ensure', 'POST', `/leases/${encodeURIComponent(id)}/ensure`, undefined, 45_000);
    if (mode === 'sign_in') {
      if (body.vnc !== 'lease' && body.cdp !== 'lease') throw malformed();
      return;
    }
    if (body.cdp !== 'lease' || body.port !== undefined) throw malformed();
  }

  vncRemote(id: string): { url: string; headers: { authorization: string } } {
    const url = new URL(`${this.provider.leaseUrl.replace(/\/+$/, '')}/leases/${encodeURIComponent(id)}/vnc`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return { url: url.href, headers: { authorization: `Bearer ${this.#token()}` } };
  }

  windowStream(id: string): WindowStream {
    return this.#mediaStream(`/leases/${encodeURIComponent(id)}/window`);
  }

  recordingStream(id: string): WindowStream {
    return this.#mediaStream(`/leases/${encodeURIComponent(id)}/recording`);
  }

  async saveSignIn(id: string, timeoutMs = 90_000): Promise<{ archive: Buffer; sha256: string }> {
    const attributes = { 'browserctl.provider': this.provider.name, 'browserctl.lease.operation': 'save' };
    return inSpan('browserctl.lease.request', attributes, async () => {
      const response = await this.#send('POST', `/leases/${encodeURIComponent(id)}/save`, undefined, {}, timeoutMs);
      if (!response.ok || !response.body) {
        if (response.status === 504) throw new BrowserctlError('timeout', 'the browser did not exit in time; the profile is unchanged');
        if (response.status === 404) throw new BrowserctlError('lease_lost', `provider ${this.provider.name} no longer knows the lease`);
        throw new BrowserctlError('provider_error', `provider ${this.provider.name} answered ${response.status}`);
      }
      const sha256 = (response.headers.get('x-revision-sha256') ?? '').trim().toLowerCase();
      if (!SHA256_HEX.test(sha256)) throw malformed();
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > MAX_ARCHIVE_BYTES) throw new BrowserctlError('provider_error', 'the provider archive exceeded the size limit');
        chunks.push(Buffer.from(chunk));
      }
      return { archive: Buffer.concat(chunks), sha256 };
    });
  }

  #mediaStream(path: string): WindowStream {
    const controller = new AbortController();
    const output = new PassThrough();
    const errorListeners: Array<() => void> = [];
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      for (const listener of errorListeners) listener();
      output.destroy();
    };
    const token = this.#token();
    void this.#fetch(`${this.provider.leaseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok || !response.body) return fail();
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        if (controller.signal.aborted || output.destroyed) break;
        output.write(Buffer.from(chunk));
      }
      if (!output.destroyed) output.end();
    }).catch(() => {
      if (!controller.signal.aborted) fail();
    });
    return {
      stream: output,
      stop: () => {
        controller.abort();
        output.destroy();
      },
      onError: (listener) => {
        if (failed) listener();
        else errorListeners.push(listener);
      },
    };
  }

  async #send(method: string, path: string, body?: Buffer, headers: Record<string, string> = {}, timeout = REQUEST_TIMEOUT_MS): Promise<Response> {
    const token = this.#token();
    let response: Response;
    try {
      response = await this.#fetch(`${this.provider.leaseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...headers },
        ...(body !== undefined && { body: new Uint8Array(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new BrowserctlError('provider_unreachable', `provider ${this.provider.name} is unreachable`, { cause: error });
    }
    if (response.status === 401) throw new BrowserctlError('provider_unauthorized', `provider ${this.provider.name} refused browserctl's token`);
    return response;
  }

  async #raw(operation: LeaseOperation, method: string, path: string, body?: Buffer, headers: Record<string, string> = {}, timeout = REQUEST_TIMEOUT_MS): Promise<Response> {
    const attributes = { 'browserctl.provider': this.provider.name, 'browserctl.lease.operation': operation };
    return inSpan('browserctl.lease.request', attributes, () => this.#send(method, path, body, headers, timeout));
  }

  async status(): Promise<{ slots: SlotStatus[]; inventory: ProviderInventory; capacity?: ProviderCapacity }> {
    const body = await this.#request('status', 'GET', '/status');
    if (!Array.isArray(body.slots)) throw malformed();
    const slots = body.slots.map((entry: unknown) => {
      const slot = (entry ?? {}) as Record<string, unknown>;
      return {
        slot: integer(slot.slot, 'slot'),
        port: port(slot.port),
        owner: typeof slot.owner === 'string' ? slot.owner.slice(0, 200) : '',
        running: slot.running === true,
        idleMs: typeof slot.idleMs === 'number' ? slot.idleMs : 0,
      };
    });
    let capacity: ProviderCapacity | undefined;
    if (body.capacity !== undefined) {
      capacity = parseCapacity(body.capacity);
      if (!capacity) throw malformed();
    }
    const inventory: ProviderInventory = { sources: [], profiles: [] };
    if (body.capabilities !== undefined) {
      const { sources, cdp, profiles, managedRuntime } = body.capabilities ?? {};
      if (cdp !== 'lease' || !Array.isArray(sources) || new Set(sources).size !== sources.length
        || !sources.every((type) => SOURCE_TYPES.includes(type)) || !Array.isArray(profiles) || profiles.length > 500
        || new Set(profiles).size !== profiles.length || !profiles.every((name) => typeof name === 'string' && PROFILE_NAME.test(name))
        || (profiles.length > 0 && !sources.includes('profile'))) throw malformed();
      if (supportsPrivateLeases(this.provider.leaseUrl)) {
        Object.assign(inventory, { sources, profiles });
        if (managedRuntime !== undefined) {
          const parsed = parseManagedRuntime(managedRuntime);
          if (this.provider.managedRuntime && parsed) inventory.managedRuntime = parsed;
        }
      }
    }
    return { slots, inventory, ...(capacity && { capacity }) };
  }

  #token(): string {
    return readProtectedFile(this.provider.tokenFile, `BROWSERCTL_PROVIDERS ${this.provider.name} tokenFile`);
  }

  #request(operation: LeaseOperation, method: string, path: string, body?: unknown, timeout = REQUEST_TIMEOUT_MS): Promise<Record<string, any>> {
    const attributes = { 'browserctl.provider': this.provider.name, 'browserctl.lease.operation': operation };
    return inSpan('browserctl.lease.request', attributes, async () => {
      const token = this.#token();
      let response: Response;
      try {
        response = await this.#fetch(`${this.provider.leaseUrl.replace(/\/+$/, '')}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
          ...(body !== undefined && { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: AbortSignal.timeout(timeout),
        });
      } catch (error) {
        throw new BrowserctlError('provider_unreachable', `provider ${this.provider.name} is unreachable`, { cause: error });
      }
      const answer = await response.text().catch(() => '');
      if (response.status === 401) throw new BrowserctlError('provider_unauthorized', `provider ${this.provider.name} refused browserctl's token`);
      if (response.status === 503 && operation === 'lease') throw new BrowserctlError('capacity', `every browser of provider ${this.provider.name} is leased`);
      if (response.status === 404 && operation === 'lease' && typeof body === 'object' && body !== null && 'source' in body) {
        throw new BrowserctlError('not_found', `the requested browser source is unavailable on provider ${this.provider.name}`);
      }
      if (response.status === 404 && operation !== 'lease' && operation !== 'status') {
        throw new BrowserctlError('lease_lost', `provider ${this.provider.name} no longer knows the lease`);
      }
      if (!response.ok) throw new BrowserctlError('provider_error', `provider ${this.provider.name} answered ${response.status}`);
      try {
        const parsed = JSON.parse(answer) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw malformed();
        return parsed as Record<string, any>;
      } catch {
        throw new BrowserctlError('provider_error', `provider ${this.provider.name} sent a malformed answer`);
      }
    });
  }
}

function parseManagedRuntime(value: unknown): ManagedRuntimeCapabilities | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw malformed();
  const { version, platform, chromeMajor, views, signIn, recording } = value as Record<string, unknown>;
  if (version !== 1 || typeof platform !== 'string' || !RUNTIME_PLATFORM.test(platform)
    || typeof chromeMajor !== 'number' || !Number.isSafeInteger(chromeMajor) || chromeMajor < 1 || chromeMajor > 9999
    || !Array.isArray(views) || new Set(views).size !== views.length
    || !views.every((entry): entry is 'screencast' | 'window' => RUNTIME_VIEWS.includes(entry as 'screencast' | 'window'))
    || (signIn !== undefined && signIn !== 'vnc')
    || (recording !== undefined && recording !== 'mp4')) throw malformed();
  return {
    version: 1, platform, chromeMajor, views,
    ...(signIn === 'vnc' && { signIn: 'vnc' }),
    ...(recording === 'mp4' && { recording: 'mp4' }),
  };
}

function malformed(): BrowserctlError {
  return new BrowserctlError('provider_error', 'the provider sent a malformed answer');
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) throw new BrowserctlError('provider_error', `the provider sent no ${field}`);
  return value;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new BrowserctlError('provider_error', `the provider sent no ${field}`);
  return value as number;
}

function port(value: unknown): number {
  const number = integer(value, 'port');
  if (number < 1 || number > 65535) throw new BrowserctlError('provider_error', 'the provider sent an invalid port');
  return number;
}
