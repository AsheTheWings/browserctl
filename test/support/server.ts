// Run-owned server configuration and directories for in-process tests.

import { mkdirSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerConfig } from '../../src/config/config.ts';
import { GITHUB_SECRET, OWNER_ID } from './github.ts';

export async function runDirectory(prefix = 'r-'): Promise<{ path: string; remove: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  // Session users must traverse it to reach their session directories, as they traverse the work directory.
  await chmod(path, 0o711);
  return { path, remove: () => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

export const DEVELOPMENT_PASSWORD = 'synthetic-development-password';

export function testConfig(root: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const clientSecretFile = join(root, 'github-client-secret');
  mkdirSync(root, { recursive: true });
  writeFileSync(clientSecretFile, GITHUB_SECRET, { mode: 0o600 });
  return {
    profile: 'production',
    stateDirectory: join(root, 'state'),
    publicBaseUrl: 'http://127.0.0.1:1',
    telemetry: { traces: 'none', metrics: 'none', logs: 'none', endpoint: 'http://127.0.0.1:4318', headersFile: undefined, deploymentEnvironment: 'test' },
    path: '/usr/local/bin:/usr/bin:/bin',
    listenAddress: '127.0.0.1',
    port: 0,
    recordingsDirectory: join(root, 'state', 'recordings'),
    recordingsCapBytes: 40 * 1024 ** 3,
    workDirectory: join(root, 'work'),
    sessionLimit: 4,
    idleSeconds: 1800,
    lifetimeSeconds: 14400,
    taskTimeoutSeconds: 600,
    serviceCheckIntervalSeconds: 43200,
    model: undefined,
    providers: [],
    dashboard: { type: 'github', clientId: 'synthetic-client', ownerId: OWNER_ID, clientSecretFile },
    ...overrides,
  };
}

/** The admin CLI's process inputs for a test's state directory, exporting nothing. */
export function adminEnvironment(stateDirectory: string): Record<string, string> {
  return {
    BROWSERCTL_STATE_DIRECTORY: stateDirectory,
    OTEL_TRACES_EXPORTER: 'none',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_LOGS_EXPORTER: 'none',
  };
}
