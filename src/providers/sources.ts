export const MANAGED_PROVIDER = 'managed';
export const SOURCE_TYPES = ['ephemeral', 'profile'] as const;
export type BrowserSource = { type: 'ephemeral' } | { type: 'profile'; name: string };
export const PROFILE_NAME = /^[a-z][a-z0-9-]{0,62}$/;
export const LEASE_EXPIRY_MS = 90_000;

/** Profile leases and management both require a confidential transport. */
export function supportsPrivateLeases(value: string): boolean {
  const url = new URL(value);
  return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname));
}

export function parseBrowserSource(value: unknown): BrowserSource | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { type, name, ...extra } = value as Record<string, unknown>;
  if (Object.keys(extra).length !== 0) return undefined;
  if (type === 'ephemeral' && name === undefined) return { type };
  if (type === 'profile' && typeof name === 'string' && PROFILE_NAME.test(name)) return { type, name };
  return undefined;
}
