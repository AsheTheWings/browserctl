// The client of an external provider's lease API, as docs/lease-protocol.md defines it. Each failure maps to a
// stable error class: a full provider to capacity, a refused token to provider_unauthorized, no answer to
// provider_unreachable, an unknown lease to lease_lost, and anything else to provider_error.

import { readProtectedFile } from '../config/config.ts';
import type { ProviderConfig } from '../config/schema.ts';
import { BrowserctlError } from '../errors.ts';
import { inSpan } from '../telemetry/signals.ts';
import { PROFILE_NAME, SOURCE_TYPES, type BrowserSource } from './sources.ts';

const REQUEST_TIMEOUT_MS = 30_000;

export type LeaseOperation = 'lease' | 'ensure' | 'heartbeat' | 'release' | 'status';

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
  sources: BrowserSource['type'][];
  profiles: string[];
}

/** Explicit-source leases can carry a signed-in browser. Require TLS outside loopback. */
export function supportsPrivateLeases(value: string): boolean {
  const url = new URL(value);
  return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname));
}

export class LeaseClient {
  readonly provider: ProviderConfig;
  readonly #fetch: typeof fetch;

  constructor(provider: ProviderConfig, fetchImpl: typeof fetch = fetch) {
    this.provider = provider;
    this.#fetch = fetchImpl;
  }

  async lease(owner: string, slot?: number, source?: BrowserSource): Promise<Lease> {
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

  async status(): Promise<{ slots: SlotStatus[]; inventory: ProviderInventory }> {
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
    const inventory: ProviderInventory = { sources: [], profiles: [] };
    if (body.capabilities !== undefined) {
      const { sources, cdp, profiles } = body.capabilities ?? {};
      if (cdp !== 'lease' || !Array.isArray(sources) || new Set(sources).size !== sources.length
        || !sources.every((type) => SOURCE_TYPES.includes(type)) || !Array.isArray(profiles) || profiles.length > 500
        || new Set(profiles).size !== profiles.length || !profiles.every((name) => typeof name === 'string' && PROFILE_NAME.test(name))
        || (profiles.length > 0 && !sources.includes('profile'))) throw malformed();
      if (supportsPrivateLeases(this.provider.leaseUrl)) Object.assign(inventory, { sources, profiles });
    }
    return { slots, inventory };
  }

  #token(): string {
    return readProtectedFile(this.provider.tokenFile, `BROWSERCTL_PROVIDERS ${this.provider.name} tokenFile`);
  }

  #request(operation: LeaseOperation, method: string, path: string, body?: unknown): Promise<Record<string, any>> {
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
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
