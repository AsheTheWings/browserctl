// Run-owned server configuration and directories for in-process tests.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerConfig } from '../../src/config/config.ts';

export async function runDirectory(prefix = 'browserctl-run-'): Promise<{ path: string; remove: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, remove: () => rm(path, { recursive: true, force: true }) };
}

export function testConfig(root: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    profile: 'development',
    stateDirectory: join(root, 'state'),
    publicBaseUrl: 'http://127.0.0.1:1',
    telemetry: { traces: 'none', metrics: 'none', logs: 'none', endpoint: 'http://127.0.0.1:4318', headersFile: undefined, deploymentEnvironment: 'test' },
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
