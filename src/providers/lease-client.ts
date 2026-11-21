// The client of an external provider's lease API, as docs/lease-protocol.md defines it. Each failure maps to a
// stable error class: a full provider to capacity, a refused token to provider_unauthorized, no answer to
// provider_unreachable, an unknown lease to lease_lost, and anything else to provider_error.

import { readProtectedFile } from '../config/config.ts';
import type { LeaseProviderConfig } from '../config/schema.ts';
import { BrowserctlError } from '../errors.ts';
import { inSpan } from '../telemetry/signals.ts';
import { PROFILE_NAME, SOURCE_TYPES, supportsPrivateLeases, type LeaseSource } from './sources.ts';

const REQUEST_TIMEOUT_MS = 30_000;

export type LeaseOperation = 'lease' | 'ensure' | 'heartbeat' | 'release' | 'status' | 'profiles';

export interface ProviderRevision {
  id: string;
  createdAt: string;
  client: string;
  pinned: boolean;
}

export interface ProviderProfile {
  name: string;
  current: string | null;
  revisions: ProviderRevision[];
}

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
  profileManagement?: 1;
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

  async listProfiles(): Promise<ProviderProfile[]> {
    const { profiles } = await this.#request('profiles', 'GET', '/profiles');
    if (!Array.isArray(profiles) || profiles.length > 500) throw malformed();
    const parsed = profiles.map((entry: unknown) => profile(entry));
    if (new Set(parsed.map(({ name }) => name)).size !== parsed.length) throw malformed();
    return parsed;
  }

  async createProfile(name: string): Promise<ProviderProfile> {
    profilePath(name);
    return profile(await this.#request('profiles', 'POST', '/profiles', { name }), name);
  }

  async deleteProfile(name: string): Promise<void> {
    const result = await this.#request('profiles', 'DELETE', profilePath(name));
    if (result.name !== name) throw malformed();
  }

  async setProfileRevision(name: string, revision: string, pinned?: boolean): Promise<ProviderProfile> {
    if (!validRevisionId(revision)) throw new BrowserctlError('invalid_request', 'invalid provider profile revision');
    const method = pinned === undefined ? 'current' : 'pin';
    const result = await this.#request('profiles', 'PUT', `${profilePath(name)}/${method}`, {
      revision, ...(pinned !== undefined && { pinned }),
    });
    return profile(result, name);
  }

  async openProfileEdit(name: string, client: string): Promise<string> {
    profilePath(name);
    const body = await this.#request('profiles', 'POST', '/profile-edits', { name, client });
    const id = text(body.lease, 'edit lease');
    if (!/^[A-Za-z0-9_-]{43}$/.test(id) || body.cdp !== 'lease' || body.port !== undefined
      || body.source?.type !== 'profile' || body.source.name !== name) throw malformed();
    try {
      const ready = await this.#request('profiles', 'POST', `/profile-edits/${id}/ensure`);
      if (ready.cdp !== 'lease' || ready.port !== undefined) throw malformed();
    } catch (error) {
      await this.discardProfileEdit(id).catch(() => undefined);
      throw error;
    }
    return id;
  }

  profileEditBrowser(id: string): { url: string; headers: { authorization: string } } {
    const url = new URL(`${this.provider.leaseUrl.replace(/\/+$/, '')}/profile-edits/${encodeURIComponent(id)}/cdp/devtools/browser`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return { url: url.href, headers: { authorization: `Bearer ${this.#managementToken()}` } };
  }

  async heartbeatProfileEdit(id: string): Promise<void> {
    await this.#request('profiles', 'POST', `/profile-edits/${encodeURIComponent(id)}/heartbeat`);
  }

  async discardProfileEdit(id: string): Promise<void> {
    await this.#request('profiles', 'DELETE', `/profile-edits/${encodeURIComponent(id)}`);
  }

  async saveProfileEdit(id: string): Promise<ProviderRevision> {
    const result = await this.#request('profiles', 'POST', `/profile-edits/${encodeURIComponent(id)}/save`, undefined, 90_000);
    return revision(result.revision);
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
      const { sources, cdp, profiles, profileManagement } = body.capabilities ?? {};
      if (cdp !== 'lease' || !Array.isArray(sources) || new Set(sources).size !== sources.length
        || !sources.every((type) => SOURCE_TYPES.includes(type)) || !Array.isArray(profiles) || profiles.length > 500
        || new Set(profiles).size !== profiles.length || !profiles.every((name) => typeof name === 'string' && PROFILE_NAME.test(name))
        || (profiles.length > 0 && !sources.includes('profile'))) throw malformed();
      if (supportsPrivateLeases(this.provider.leaseUrl)) {
        Object.assign(inventory, { sources, profiles });
        if (profileManagement === 1 && sources.includes('profile') && this.provider.profileTokenFile) {
          inventory.profileManagement = 1;
        }
      }
    }
    return { slots, inventory };
  }

  #token(): string {
    return readProtectedFile(this.provider.tokenFile, `BROWSERCTL_PROVIDERS ${this.provider.name} tokenFile`);
  }

  #managementToken(): string {
    const file = this.provider.profileTokenFile;
    if (!file || !supportsPrivateLeases(this.provider.leaseUrl)) {
      throw new BrowserctlError('invalid_request', 'profile management is not enabled for this provider');
    }
    const token = readProtectedFile(file, `BROWSERCTL_PROVIDERS ${this.provider.name} profileTokenFile`);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token || token === this.#token()) {
      throw new BrowserctlError('provider_unauthorized', 'the provider profile credential is invalid');
    }
    return token;
  }

  #request(operation: LeaseOperation, method: string, path: string, body?: unknown, timeout = REQUEST_TIMEOUT_MS): Promise<Record<string, any>> {
    const attributes = { 'browserctl.provider': this.provider.name, 'browserctl.lease.operation': operation };
    return inSpan('browserctl.lease.request', attributes, async () => {
      const management = operation === 'profiles';
      const token = management ? this.#managementToken() : this.#token();
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
      if (management && response.status === 404) throw new BrowserctlError('not_found', 'provider profile or revision not found');
      if (management && response.status === 409) throw new BrowserctlError('conflict', 'the provider could not apply the profile change');
      if (management && response.status === 503) throw new BrowserctlError('capacity', 'the provider has no room for this profile operation');
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

function profilePath(name: string): string {
  if (!PROFILE_NAME.test(name)) throw new BrowserctlError('invalid_request', 'invalid provider profile name');
  return `/profiles/${name}`;
}

function validRevisionId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

function revision(value: unknown): ProviderRevision {
  const { id, createdAt, client, pinned } = (value ?? {}) as Record<string, unknown>;
  if (!validRevisionId(id) || typeof createdAt !== 'string' || createdAt.length > 32 || !Number.isFinite(Date.parse(createdAt))
    || typeof client !== 'string' || client.length === 0 || client.length > 200 || typeof pinned !== 'boolean') throw malformed();
  return { id, createdAt, client, pinned };
}

function profile(value: unknown, expectedName?: string): ProviderProfile {
  const { name, current, revisions } = (value ?? {}) as Record<string, unknown>;
  if (typeof name !== 'string' || !PROFILE_NAME.test(name) || (expectedName !== undefined && name !== expectedName)
    || !Array.isArray(revisions) || (current !== null && !validRevisionId(current))) throw malformed();
  const parsed = revisions.map(revision);
  const ids = new Set(parsed.map(({ id }) => id));
  if (ids.size !== parsed.length || (ids.size === 0 ? current !== null : current === null || !ids.has(current))) throw malformed();
  return { name, current, revisions: parsed };
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
