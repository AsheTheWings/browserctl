export const MANAGED_PROVIDER = 'managed';
export const SOURCE_TYPES = ['ephemeral', 'profile'] as const;
export type LeaseSource = { type: 'ephemeral' } | { type: 'profile'; name: string };
export type BrowserSource = LeaseSource | { type: 'existing' };
export const PROFILE_NAME = /^[a-z][a-z0-9-]{0,62}$/;
export const LEASE_EXPIRY_MS = 90_000;

export interface ProviderCapacity {
  total: number;
  used: number;
  available: number;
  queued?: number;
}

export function parseCapacity(value: unknown): ProviderCapacity | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { total, used, available, queued, ...extra } = value as Record<string, unknown>;
  if (Object.keys(extra).length !== 0) return undefined;
  const nonNegative = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!nonNegative(total) || !nonNegative(used) || !nonNegative(available)) return undefined;
  if (used > total || available > total) return undefined;
  if (queued !== undefined && !nonNegative(queued)) return undefined;
  return { total, used, available, ...(queued !== undefined && { queued }) };
}

/** Profile leases and management both require a confidential transport. */
export function supportsPrivateLeases(value: string): boolean {
  const url = new URL(value);
  return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname));
}

export function parseBrowserSource(value: unknown): BrowserSource | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { type, name, ...extra } = value as Record<string, unknown>;
  if (Object.keys(extra).length !== 0) return undefined;
  if ((type === 'ephemeral' || type === 'existing') && !('name' in value)) return { type };
  if (type === 'profile' && typeof name === 'string' && PROFILE_NAME.test(name)) return { type, name };
  return undefined;
}
