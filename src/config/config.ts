// Typed configuration for each entry point, built from the layered inputs.

import { readFileSync, statSync } from 'node:fs';
import { workDirectoryProblem } from '../sessions/workspace.ts';
import { ConfigError, parseProviders, resolve, type LayerReader, type Profile, type ProviderConfig } from './schema.ts';

export type Exporter = 'otlp' | 'console' | 'none';

export interface TelemetryConfig {
  traces: Exporter;
  metrics: Exporter;
  logs: Exporter;
  endpoint: string;
  headersFile: string | undefined;
  deploymentEnvironment: string;
}

export interface AdminConfig {
  profile: Profile;
  stateDirectory: string;
  telemetry: TelemetryConfig;
}

export type DashboardConfig =
  | { type: 'github'; clientId: string; ownerId: number; clientSecretFile: string }
  | { type: 'password'; passwordFile: string };

export const DASHBOARD_PASSWORD_INPUT = 'BROWSERCTL_DASHBOARD_PASSWORD_FILE';

export interface ServerConfig extends AdminConfig {
  publicBaseUrl: string;
  /** The PATH child processes get, and where the server finds its executables. */
  path: string;
  listenAddress: string;
  port: number;
  recordingsDirectory: string;
  recordingsCapBytes: number;
  workDirectory: string;
  sessionLimit: number;
  idleSeconds: number;
  lifetimeSeconds: number;
  taskTimeoutSeconds: number;
  serviceCheckIntervalSeconds: number;
  model: { baseUrl: string; name: string; keyFile: string } | undefined;
  dashboard: DashboardConfig;
  providers: ProviderConfig[];
  providerTokenFile?: string;
}

/** Reads a layer file from disk; a missing file is an absent layer. */
export const diskReader: LayerReader = (path) => {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return { text, ownerOnly: isOwnerOnly(path) };
};

export function isOwnerOnly(path: string): boolean {
  const stat = statSync(path);
  return (stat.mode & 0o077) === 0 && stat.uid === process.geteuid?.();
}

/** Read a delivered protected file whole; it must be readable by its owner alone. */
export function readProtectedFile(path: string, input: string, trimNewline = true): string {
  let text: string;
  try {
    if (!isOwnerOnly(path)) throw new ConfigError([`${input}: ${path} must be readable by its owner alone`]);
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError([`${input}: ${path} is unreadable`]);
  }
  return trimNewline ? text.replace(/\r?\n$/, '') : text;
}

/** Check that every protected file the effective inputs name exists, is readable, and is owner-only, so a
 * mis-delivered secret stops the server at startup instead of at first use. */
export function verifyProtectedFiles(config: ServerConfig): void {
  const problems: string[] = [];
  const files: Array<[string, string, boolean?]> = [];
  if (config.dashboard.type === 'github') files.push([config.dashboard.clientSecretFile, 'BROWSERCTL_GITHUB_CLIENT_SECRET_FILE', false]);
  else {
    const path = config.dashboard.passwordFile;
    try {
      const password = readProtectedFile(path, DASHBOARD_PASSWORD_INPUT, false);
      const length = [...password].length;
      if (length < 15 || length > 256 || /[\r\n]/.test(password)) {
        problems.push(`${DASHBOARD_PASSWORD_INPUT}: want a single-line password of 15 to 256 characters`);
      }
    } catch (error) {
      problems.push(...(error as ConfigError).problems);
    }
  }
  if (config.model) files.push([config.model.keyFile, 'BROWSERCTL_MODEL_KEY_FILE']);
  if (config.providerTokenFile) {
    try {
      const token = readProtectedFile(config.providerTokenFile, 'BROWSERCTL_PROVIDER_TOKEN_FILE');
      if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) {
        problems.push('BROWSERCTL_PROVIDER_TOKEN_FILE: want 32 random bytes encoded as unpadded base64url');
      }
    } catch (error) {
      problems.push(...(error as ConfigError).problems);
    }
    if (config.listenAddress !== '127.0.0.1' && config.listenAddress !== '::1') {
      problems.push('BROWSERCTL_LISTEN_ADDRESS: serving browser leases requires numeric loopback');
    }
  }
  if (config.telemetry.headersFile) files.push([config.telemetry.headersFile, 'BROWSERCTL_OTLP_HEADERS_FILE']);
  for (const provider of config.providers) files.push([provider.tokenFile, `BROWSERCTL_PROVIDERS ${provider.name} tokenFile`]);
  for (const [path, input, trimNewline] of files) {
    try {
      if (readProtectedFile(path, input, trimNewline) === '') problems.push(`${input}: ${path} is empty`);
    } catch (error) {
      problems.push(...(error as ConfigError).problems);
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
}

function telemetry(values: Map<string, string>): TelemetryConfig {
  const traces = values.get('OTEL_TRACES_EXPORTER') as Exporter;
  const metrics = values.get('OTEL_METRICS_EXPORTER') as Exporter;
  const logs = values.get('OTEL_LOGS_EXPORTER') as Exporter;
  const endpoint = values.get('OTEL_EXPORTER_OTLP_ENDPOINT')!;
  return {
    traces,
    metrics,
    logs,
    endpoint: endpoint.replace(/\/+$/, ''),
    headersFile: values.get('BROWSERCTL_OTLP_HEADERS_FILE') || undefined,
    deploymentEnvironment: values.get('BROWSERCTL_DEPLOYMENT_ENVIRONMENT')!,
  };
}

export function loadAdminConfig(environment: Record<string, string | undefined>, read: LayerReader = diskReader): AdminConfig {
  const { profile, values } = resolve('admin', environment, read);
  return {
    profile,
    stateDirectory: values.get('BROWSERCTL_STATE_DIRECTORY')!,
    telemetry: telemetry(values),
  };
}

export function loadServerConfig(environment: Record<string, string | undefined>, read: LayerReader = diskReader): ServerConfig {
  const { profile, values } = resolve('server', environment, read);
  const integer = (name: string) => Number(values.get(name));
  const publicBaseUrl = new URL(values.get('BROWSERCTL_PUBLIC_BASE_URL')!);
  if (publicBaseUrl.pathname !== '/') {
    throw new ConfigError(['BROWSERCTL_PUBLIC_BASE_URL: want an origin without a path']);
  }
  if (profile === 'production' && publicBaseUrl.protocol !== 'https:') {
    throw new ConfigError(['BROWSERCTL_PUBLIC_BASE_URL: production requires an HTTPS origin']);
  }
  const github = {
    clientId: values.get('BROWSERCTL_GITHUB_CLIENT_ID')!,
    ownerId: values.get('BROWSERCTL_GITHUB_OWNER_ID')!,
    clientSecretFile: values.get('BROWSERCTL_GITHUB_CLIENT_SECRET_FILE')!,
  };
  const passwordFile = values.get(DASHBOARD_PASSWORD_INPUT)!;
  let dashboard: DashboardConfig;
  if (profile === 'production') {
    if (passwordFile) throw new ConfigError([`${DASHBOARD_PASSWORD_INPUT}: only applies to development`]);
    if (!github.clientId || !github.ownerId || !github.clientSecretFile) {
      throw new ConfigError(['production GitHub OAuth inputs must be nonempty']);
    }
    dashboard = { ...github, type: 'github', ownerId: Number(github.ownerId) };
  } else {
    if (Object.values(github).some(Boolean)) {
      throw new ConfigError(['GitHub OAuth inputs only apply to production']);
    }
    if (!passwordFile) throw new ConfigError([`${DASHBOARD_PASSWORD_INPUT}: must be nonempty in development`]);
    dashboard = { type: 'password', passwordFile };
  }
  const baseUrl = values.get('BROWSERCTL_MODEL_BASE_URL')!;
  const name = values.get('BROWSERCTL_MODEL_NAME')!;
  const keyFile = values.get('BROWSERCTL_MODEL_KEY_FILE')!;
  const modelSet = [baseUrl, name, keyFile].filter((value) => value !== '').length;
  if (modelSet !== 0 && modelSet !== 3) {
    throw new ConfigError(['BROWSERCTL_MODEL_BASE_URL, BROWSERCTL_MODEL_NAME, BROWSERCTL_MODEL_KEY_FILE: set all three or none']);
  }
  const workProblem = workDirectoryProblem(values.get('BROWSERCTL_WORK_DIRECTORY')!);
  if (workProblem) throw new ConfigError([workProblem]);
  const providerTokenFile = values.get('BROWSERCTL_PROVIDER_TOKEN_FILE');
  return {
    profile,
    stateDirectory: values.get('BROWSERCTL_STATE_DIRECTORY')!,
    publicBaseUrl: publicBaseUrl.origin,
    telemetry: telemetry(values),
    path: values.get('PATH')!,
    listenAddress: values.get('BROWSERCTL_LISTEN_ADDRESS')!,
    port: integer('BROWSERCTL_PORT'),
    recordingsDirectory: values.get('BROWSERCTL_RECORDINGS_DIRECTORY')!,
    recordingsCapBytes: integer('BROWSERCTL_RECORDINGS_CAP_BYTES'),
    workDirectory: values.get('BROWSERCTL_WORK_DIRECTORY')!,
    sessionLimit: integer('BROWSERCTL_SESSION_LIMIT'),
    idleSeconds: integer('BROWSERCTL_SESSION_IDLE_SECONDS'),
    lifetimeSeconds: integer('BROWSERCTL_SESSION_LIFETIME_SECONDS'),
    taskTimeoutSeconds: integer('BROWSERCTL_TASK_TIMEOUT_SECONDS'),
    serviceCheckIntervalSeconds: integer('BROWSERCTL_SERVICE_CHECK_INTERVAL_SECONDS'),
    model: modelSet === 3 ? { baseUrl: baseUrl.replace(/\/+$/, ''), name, keyFile } : undefined,
    dashboard,
    providers: parseProviders(values.get('BROWSERCTL_PROVIDERS')!),
    ...(providerTokenFile && { providerTokenFile }),
  };
}
