// The server's composition: state, authentication, sessions and their relay, recordings, the admin socket, and the
// HTTP listener.

import { chmod, mkdir, readdir, rm } from 'node:fs/promises';
import { isIPv6 } from 'node:net';
import { dirname, join } from 'node:path';
import { AdminServer } from '../admin/socket.ts';
import { AuditLog } from '../audit.ts';
import { TokenStore } from '../auth/tokens.ts';
import { Relay } from '../browser/relay.ts';
import { verifyProtectedFiles, type ServerConfig } from '../config/config.ts';
import { BrowserctlError } from '../errors.ts';
import { ProfileStore } from '../profiles/store.ts';
import { ConfigError } from '../config/schema.ts';
import { buildInfo } from '../build-info.ts';
import { DashboardAuth } from '../dashboard/auth.ts';
import { Dashboard } from '../dashboard/dashboard.ts';
import { Screencasts } from '../dashboard/screencast.ts';
import { displayOpener } from '../signin/display.ts';
import { McpEndpoint } from '../mcp/endpoint.ts';
import { Providers } from '../providers/external.ts';
import { Recorder } from '../recordings/recorder.ts';
import { RecordingStore } from '../recordings/store.ts';
import { SessionManager } from '../sessions/manager.ts';
import { ServiceChecks } from '../tasks/checks.ts';
import { ModelForwarder } from '../tasks/forwarder.ts';
import { TaskRunner } from '../tasks/runner.ts';
import { RunLog } from '../tasks/runs.ts';
import { TaskStore } from '../tasks/store.ts';
import { untraversableAncestors, workDirectoryProblem } from '../sessions/workspace.ts';
import { HttpRouter, sendJson } from './http.ts';

export const ADMIN_CLIENT = 'admin';
const SESSION_DIRECTORY = /^s-[A-Za-z0-9_-]{12}$/;

/** Run one startup step; a system failure becomes a message naming the step and its error code. */
async function step<T>(description: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BrowserctlError || error instanceof ConfigError) throw error;
    const code = (error as NodeJS.ErrnoException).code ?? 'error';
    throw new BrowserctlError('internal', `cannot ${description} (${code})`, { cause: error });
  }
}

/** The address the server's own children use to reach its listener. */
export function internalHost(listenAddress: string): string {
  if (listenAddress === '0.0.0.0') return '127.0.0.1';
  if (listenAddress === '::') return '[::1]';
  return isIPv6(listenAddress) ? `[${listenAddress}]` : listenAddress;
}

export class BrowserctlServer {
  readonly config: ServerConfig;
  readonly tokens: TokenStore;
  readonly audit: AuditLog;
  readonly profiles: ProfileStore;
  readonly tasks: TaskStore;
  readonly forwarder: ModelForwarder;
  readonly runner: TaskRunner;
  readonly runs: RunLog;
  readonly checks: ServiceChecks;
  readonly dashboardAuth: DashboardAuth;
  readonly dashboard: Dashboard;
  readonly screencasts: Screencasts;
  readonly recordings: RecordingStore;
  readonly recorder: Recorder;
  readonly relay = new Relay();
  readonly sessions: SessionManager;
  readonly mcp: McpEndpoint;
  readonly providers: Providers;
  readonly admin = new AdminServer();
  readonly http = new HttpRouter();
  port = 0;

  constructor(config: ServerConfig) {
    this.config = config;
    this.tokens = new TokenStore(config.stateDirectory);
    this.audit = new AuditLog(config.stateDirectory);
    this.profiles = new ProfileStore(config.stateDirectory);
    this.tasks = new TaskStore(config.stateDirectory);
    this.forwarder = new ModelForwarder(config.model);
    this.runs = new RunLog(config.stateDirectory);
    const internalBase = () => `http://${internalHost(config.listenAddress)}:${this.port}`;
    this.sessions = new SessionManager({
      workDirectory: config.workDirectory,
      path: config.path,
      sessionLimit: config.sessionLimit,
      idleSeconds: config.idleSeconds,
      lifetimeSeconds: config.lifetimeSeconds,
      internalBase,
      relay: this.relay,
      profiles: this.profiles,
      audit: this.audit,
    });
    this.providers = new Providers(config.providers, { onLeaseLost: (session) => void this.sessions.close(session, 'lease_lost') });
    this.sessions.externalOpener = this.providers.opener;
    this.sessions.displayOpener = displayOpener(config.path);
    this.runner = new TaskRunner({
      tasks: this.tasks,
      sessions: this.sessions,
      forwarder: this.forwarder,
      runs: this.runs,
      audit: this.audit,
      path: config.path,
      timeoutSeconds: config.taskTimeoutSeconds,
      internalBase,
    });
    this.checks = new ServiceChecks({ profiles: this.profiles, sessions: this.sessions, runner: this.runner, intervalSeconds: config.serviceCheckIntervalSeconds });
    this.screencasts = new Screencasts(this.sessions, this.providers);
    this.recordings = new RecordingStore(config.recordingsDirectory, config.recordingsCapBytes);
    this.recorder = new Recorder({ sessions: this.sessions, screencasts: this.screencasts, store: this.recordings, path: config.path });
    this.dashboardAuth = new DashboardAuth(config.stateDirectory, this.tokens);
    this.dashboard = new Dashboard({
      publicBaseUrl: config.publicBaseUrl,
      auth: this.dashboardAuth,
      sessions: this.sessions,
      profiles: this.profiles,
      tasks: this.tasks,
      runs: this.runs,
      checks: this.checks,
      providers: this.providers,
      screencasts: this.screencasts,
      recordings: this.recordings,
      audit: this.audit,
    });
    this.mcp = new McpEndpoint({
      tokens: this.tokens,
      sessions: this.sessions,
      profiles: this.profiles,
      tasks: this.tasks,
      runner: this.runner,
      audit: this.audit,
      path: config.path,
      version: buildInfo().version,
      idleSeconds: config.idleSeconds,
    });
  }

  async start(): Promise<void> {
    const { config } = this;
    const workProblem = workDirectoryProblem(config.workDirectory);
    if (workProblem) throw new ConfigError([workProblem]);
    verifyProtectedFiles(config);
    // Missing ancestors get the umask's mode, so a new state directory never blocks a work directory beside it.
    await step('create the state directory', async () => {
      await mkdir(dirname(config.stateDirectory), { recursive: true });
      await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
      await chmod(config.stateDirectory, 0o700);
    });
    // The admin socket claims the state directory, so no cleanup below touches a live server's sessions or profiles.
    await step('open the admin socket', () => this.admin.listen(config.stateDirectory));
    await step('prepare the session work directory', async () => {
      await mkdir(dirname(config.workDirectory), { recursive: true });
      await mkdir(config.workDirectory, { recursive: true, mode: 0o711 });
      await chmod(config.workDirectory, 0o711);
      const blocked = await untraversableAncestors(config.workDirectory);
      if (blocked.length > 0) throw new ConfigError([`BROWSERCTL_WORK_DIRECTORY: browser users cannot pass through ${blocked.join(', ')}`]);
      // Sessions never outlive the server; a crash can leave their directories behind.
      for (const name of await readdir(config.workDirectory)) {
        if (SESSION_DIRECTORY.test(name)) await rm(join(config.workDirectory, name), { recursive: true, force: true });
      }
    });
    await step('create the recordings directory', async () => {
      await mkdir(config.recordingsDirectory, { recursive: true, mode: 0o700 });
      await chmod(config.recordingsDirectory, 0o700);
    });
    await step('load the recordings', () => this.recorder.start());
    await step('clean up interrupted profile changes', () => this.profiles.sweepLeftovers());
    await step('clean up interrupted task cache changes', () => this.tasks.sweepLeftovers());
    await this.tokens.load();
    await this.dashboardAuth.load();
    this.tokens.onRevoked((client) => {
      void this.dashboard.closeClient(client);
      void this.mcp.closeClient(client);
      void this.sessions.closeClient(client, 'revoked');
    });
    this.#adminCommands();
    this.http.route('/healthz', (_request, response) => sendJson(response, 200, { status: 'ok' }));
    this.relay.mount(this.http);
    this.mcp.mount(this.http);
    this.forwarder.mount(this.http);
    this.dashboard.mount(this.http);
    this.port = await step(`listen on ${config.listenAddress}:${config.port}`, () => this.http.listen(config.listenAddress, config.port));
    this.sessions.start();
    this.screencasts.start();
    this.providers.start();
    this.checks.start();
    this.admin.ready();
  }

  #adminCommands(): void {
    const name = (args: Record<string, unknown>) => {
      if (typeof args.name !== 'string') throw new BrowserctlError('invalid_request', 'a client name is required');
      return args.name;
    };
    this.admin.handle('tokens.create', async (args) => {
      const client = name(args);
      const token = await this.tokens.create(client);
      await this.audit.record(ADMIN_CLIENT, 'token.create', client);
      return { name: client, token };
    });
    this.admin.handle('tokens.list', async () => this.tokens.list());
    this.admin.handle('dashboard.link', async (args) => {
      const client = name(args);
      const token = this.dashboardAuth.link(client);
      await this.audit.record(ADMIN_CLIENT, 'dashboard.link', client);
      return { url: `${this.config.publicBaseUrl.replace(/\/+$/, '')}/dashboard/login?token=${token}` };
    });
    this.admin.handle('tokens.revoke', async (args) => {
      const client = name(args);
      await this.tokens.revoke(client);
      await this.audit.record(ADMIN_CLIENT, 'token.revoke', client);
      return { name: client };
    });
    // Opens an ephemeral session, checks that its browser answers, and closes it.
    this.admin.handle('sessions.check', async () => {
      const session = await this.sessions.open(ADMIN_CLIENT, { kind: 'ephemeral' });
      try {
        const version = await session.browser!.cdp!.call<{ product: string }>('Browser.getVersion');
        return { session: session.id, browser: version.product };
      } finally {
        await this.sessions.close(session, 'closed');
      }
    });
  }

  async stop(): Promise<void> {
    this.checks.stop();
    this.dashboard.stop();
    this.providers.stop();
    await this.mcp.stop();
    await this.sessions.stop();
    // Closed sessions end their screencasts, so each recording finishes its video before the server stops.
    await this.recorder.stop();
    this.screencasts.stop();
    await this.admin.close();
    await this.http.close();
  }
}
