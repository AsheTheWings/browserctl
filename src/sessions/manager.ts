// Sessions: one browser held for one client, from a profile copy, an empty profile, or an external provider, until
// it is closed, idles out, outlives its maximum lifetime, or the server shuts down.

import { randomBytes } from 'node:crypto';
import type { AuditLog } from '../audit.ts';
import { launchChrome, type ChromeProcess } from '../browser/chrome.ts';
import type { CdpConnection } from '../browser/cdp.ts';
import { ManagedTarget, type Registration, type Relay, type RelayTarget } from '../browser/relay.ts';
import { BrowserctlError } from '../errors.ts';
import type { ProfileStore, Revision } from '../profiles/store.ts';
import { chownTree } from '../profiles/copy.ts';
import { inSpan, instrument } from '../telemetry/signals.ts';
import { Slots } from './slots.ts';
import { UserPool, killUserProcesses, type UserPair } from './users.ts';
import { createWorkspace, removeWorkspace, type Workspace } from './workspace.ts';

export type Source = { kind: 'profile'; profile: string } | { kind: 'ephemeral' } | { kind: 'provider'; provider: string; slot?: number };
export type Purpose = 'agent' | 'check' | 'sign_in';
export type CloseReason = 'closed' | 'idle' | 'lifetime' | 'shutdown' | 'revoked' | 'browser_exited' | 'lease_lost' | 'failed';
export type SourceLabel = 'profile' | 'ephemeral' | 'provider' | 'sign_in' | 'check';

export const QUEUE_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 5_000;
const SWEEP_INTERVAL_MS = 5_000;
export const WINDOW = { width: 1280, height: 800 };

/** Work a session holds that must stop before its browser and directories go, such as a worker or a lease. */
export type Closer = (reason: CloseReason) => Promise<void>;

/** A browser a session drives, behind the relay for agent and check sessions. */
export interface SessionBrowser {
  /** The server's own CDP connection, when it has one. */
  cdp: CdpConnection | undefined;
  /** The browser's main process, for a managed browser. */
  pid: number | undefined;
  /** Ask the browser to exit cleanly, flushing its profile; resolves whether it exited in time. */
  exit(timeoutMs: number): Promise<boolean>;
  /** Stop the browser for good. */
  stop(): Promise<void>;
}

export interface Session {
  id: string;
  client: string;
  purpose: Purpose;
  source: Source;
  createdAt: number;
  lastActivity: number;
  state: 'starting' | 'ready' | 'saving' | 'closing' | 'closed';
  users: UserPair;
  workspace: Workspace;
  /** The profile revision a profile session started from. */
  revision: string | undefined;
  browser: SessionBrowser | undefined;
  registration: Registration | undefined;
  closers: Closer[];
  closed: Promise<void>;
}

export function sourceLabel(session: Pick<Session, 'purpose' | 'source'>): SourceLabel {
  if (session.purpose === 'sign_in') return 'sign_in';
  if (session.purpose === 'check') return 'check';
  return session.source.kind;
}

export interface ManagerOptions {
  workDirectory: string;
  path: string;
  sessionLimit: number;
  idleSeconds: number;
  lifetimeSeconds: number;
  /** The HTTP base workers and task runs reach the relay on. */
  internalBase: () => string;
  relay: Relay;
  profiles: ProfileStore;
  audit: AuditLog;
  queueTimeoutMs?: number;
}

/** How an external provider session gets its browser; the provider client supplies it. */
export type ExternalOpener = (session: Session) => Promise<{ browser: SessionBrowser; target: RelayTarget }>;

/** Starts a sign-in session's headful browser; the sign-in module supplies it. */
export type DisplayOpener = (session: Session) => Promise<SessionBrowser>;

export class SessionManager {
  readonly #options: ManagerOptions;
  readonly #sessions = new Map<string, Session>();
  readonly #slots: Slots;
  readonly #users = new UserPool();
  readonly #resolvers = new Map<Session, () => void>();
  /** Frees a managed session's place under the limit once its browser has stopped. */
  readonly #releases = new Map<Session, () => void>();
  /** Close reasons that arrived while a session was starting or saving; it closes once that settles. */
  readonly #pendingCloses = new Map<Session, CloseReason>();
  readonly #openListeners: Array<(session: Session) => void> = [];
  readonly #closeListeners: Array<(session: Session, reason: CloseReason) => void> = [];
  #sweeper: NodeJS.Timeout | undefined;
  #stopping = false;
  externalOpener: ExternalOpener | undefined;
  displayOpener: DisplayOpener | undefined;

  constructor(options: ManagerOptions) {
    this.#options = options;
    this.#slots = new Slots(options.sessionLimit);
  }

  start(): void {
    this.#sweeper = setInterval(() => void this.sweep(Date.now()), SWEEP_INTERVAL_MS);
    this.#sweeper.unref();
  }

  onOpen(listener: (session: Session) => void): void {
    this.#openListeners.push(listener);
  }

  onClose(listener: (session: Session, reason: CloseReason) => void): void {
    this.#closeListeners.push(listener);
  }

  list(): Session[] {
    return [...this.#sessions.values()];
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  /** Whether any live session uses a profile. */
  usesProfile(name: string): boolean {
    return this.list().some((session) => session.source.kind === 'profile' && session.source.profile === name);
  }

  touch(session: Session): void {
    session.lastActivity = Date.now();
  }

  open(client: string, source: Source, purpose: Purpose = 'agent'): Promise<Session> {
    if (this.#stopping) return Promise.reject(shuttingDown());
    const label = sourceLabel({ purpose, source });
    return inSpan('browserctl.session.open', { 'browserctl.session.source': label }, async (span) => {
      const managed = source.kind !== 'provider';
      let release: (() => void) | undefined;
      if (managed) {
        const started = performance.now();
        try {
          release = await this.#slots.acquire(this.#options.queueTimeoutMs ?? QUEUE_TIMEOUT_MS);
          if (this.#stopping) {
            release();
            throw shuttingDown();
          }
          instrument().queueWait.record((performance.now() - started) / 1000, { 'browserctl.session.queue_outcome': 'granted' });
        } catch (error) {
          instrument().queueWait.record((performance.now() - started) / 1000, { 'browserctl.session.queue_outcome': 'capacity' });
          throw error;
        }
      }
      let users: UserPair;
      try {
        users = this.#users.take();
      } catch (error) {
        release?.();
        throw error;
      }
      const id = `s-${randomBytes(9).toString('base64url')}`;
      span.setAttribute('browserctl.session.id', id);
      let resolveClosed!: () => void;
      const session: Session = {
        id,
        client,
        purpose,
        source,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        state: 'starting',
        users,
        workspace: undefined as unknown as Workspace,
        revision: undefined,
        browser: undefined,
        registration: undefined,
        closers: [],
        closed: new Promise((resolve) => (resolveClosed = resolve)),
      };
      this.#resolvers.set(session, resolveClosed);
      if (release) this.#releases.set(session, release);
      this.#sessions.set(id, session);
      try {
        await killUserProcesses(users.browserUid);
        await killUserProcesses(users.sessionUid);
        session.workspace = await createWorkspace(this.#options.workDirectory, id, users);
        await this.#startBrowser(session);
      } catch (error) {
        this.#pendingCloses.delete(session);
        await this.#finish(session, 'failed');
        throw error;
      }
      const pending = this.#pendingCloses.get(session);
      if (pending) {
        this.#pendingCloses.delete(session);
        await this.#finish(session, pending);
        throw new BrowserctlError('browser_failed', 'the session closed while it opened');
      }
      session.state = 'ready';
      instrument().sessionsLive.add(1, { 'browserctl.session.source': label });
      await this.#options.audit.record(client, 'session.open', id, { source: label, ...(source.kind === 'profile' && { profile: source.profile }) });
      for (const listener of this.#openListeners) listener(session);
      return session;
    });
  }

  async #startBrowser(session: Session): Promise<void> {
    const { source, workspace, users } = session;
    if (source.kind === 'provider') {
      if (!this.externalOpener) throw new BrowserctlError('not_found', `no provider ${source.provider}`);
      const { browser, target } = await this.externalOpener(session);
      session.browser = browser;
      session.registration = this.#options.relay.register(target, () => this.touch(session));
      return;
    }
    if (source.kind === 'profile') {
      session.revision = await this.#options.profiles.copyCurrent(source.profile, workspace.profile);
      await chownTree(workspace.profile, users.browserUid, users.gid);
    }
    if (session.purpose === 'sign_in') {
      if (!this.displayOpener) throw new BrowserctlError('internal', 'sign-in sessions are unavailable');
      session.browser = await this.displayOpener(session);
      return;
    }
    const chrome = await launchChrome({
      userDataDir: workspace.profile,
      uid: users.browserUid,
      gid: users.gid,
      home: workspace.browserHome,
      temp: workspace.browserTemp,
      path: this.#options.path,
      mode: { kind: 'pipe' },
      windowSize: WINDOW,
    });
    session.browser = chromeBrowser(chrome);
    void chrome.exited.then(() => {
      if (session.state === 'ready' || session.state === 'starting') void this.close(session, 'browser_exited');
    });
    session.registration = this.#options.relay.register(new ManagedTarget(chrome.cdp!), () => this.touch(session));
  }

  /** Save a profile session's working copy as the profile's new current revision, then close the session. The
   * browser must exit cleanly first, so its profile is complete; one that does not exit in time fails the save and
   * leaves the profile unchanged. */
  saveRevision(session: Session, client: string, exitTimeoutMs: number): Promise<Revision> {
    const { source } = session;
    if (source.kind !== 'profile' || session.purpose !== 'sign_in' || session.state !== 'ready') {
      return Promise.reject(new BrowserctlError('invalid_request', 'only an open sign-in session can be saved'));
    }
    session.state = 'saving';
    return inSpan('browserctl.snapshot.save', { 'browserctl.session.id': session.id }, async () => {
      try {
        if (!(await session.browser!.exit(exitTimeoutMs))) throw new BrowserctlError('timeout', 'the browser did not exit in time; the profile is unchanged');
        // No process of the browser user may change the working copy while the server copies it.
        await killUserProcesses(session.users.browserUid);
        const revision = await this.#options.profiles.addRevision(source.profile, session.workspace.profile, client);
        await this.#options.audit.record(client, 'profile.save', source.profile, { revision: revision.id, session: session.id });
        return revision;
      } finally {
        if (session.state === 'saving') session.state = 'ready';
        const pending = this.#pendingCloses.get(session);
        this.#pendingCloses.delete(session);
        await this.close(session, pending ?? 'closed');
      }
    });
  }

  /** The relay endpoint of a session, for its worker and task runs. */
  endpoint(session: Session): string {
    if (!session.registration) throw new BrowserctlError('invalid_request', 'this session has no CDP endpoint');
    return session.registration.endpoint(this.#options.internalBase());
  }

  /** Close a session: stop its work, revoke its capability, stop its browser, and remove its directories. A session
   * still starting closes as soon as its start settles. */
  close(session: Session, reason: CloseReason): Promise<void> {
    if (session.state === 'starting' || session.state === 'saving') {
      if (!this.#pendingCloses.has(session)) this.#pendingCloses.set(session, reason);
      return session.closed;
    }
    return this.#finish(session, reason);
  }

  #finish(session: Session, reason: CloseReason): Promise<void> {
    if (session.state === 'closing' || session.state === 'closed') return session.closed;
    const wasReady = session.state === 'ready';
    session.state = 'closing';
    const label = sourceLabel(session);
    void inSpan('browserctl.session.close', { 'browserctl.session.id': session.id, 'browserctl.session.source': label, 'browserctl.session.close_reason': reason }, async () => {
      session.registration?.revoke();
      for (const closer of [...session.closers].reverse()) {
        await closer(reason).catch(() => undefined);
      }
      await session.browser?.stop().catch(() => undefined);
      await killUserProcesses(session.users.browserUid).catch(() => undefined);
      await killUserProcesses(session.users.sessionUid).catch(() => undefined);
      this.#releases.get(session)?.();
      this.#releases.delete(session);
      if (session.workspace) await removeWorkspace(session.workspace).catch(() => undefined);
      this.#users.give(session.users);
      this.#sessions.delete(session.id);
      session.state = 'closed';
      if (wasReady) {
        instrument().sessionsLive.add(-1, { 'browserctl.session.source': label });
        await this.#options.audit.record(session.client, 'session.close', session.id, { reason }).catch(() => undefined);
      }
      for (const listener of this.#closeListeners) listener(session, reason);
    })
      .catch(() => undefined)
      .finally(() => {
        this.#resolvers.get(session)?.();
        this.#resolvers.delete(session);
      });
    return session.closed;
  }

  /** Close sessions past their idle timeout or maximum lifetime. */
  async sweep(now: number): Promise<void> {
    const idleMs = this.#options.idleSeconds * 1000;
    const lifetimeMs = this.#options.lifetimeSeconds * 1000;
    const closing: Array<Promise<void>> = [];
    for (const session of this.list()) {
      if (session.state !== 'ready') continue;
      if (now - session.createdAt >= lifetimeMs) closing.push(this.close(session, 'lifetime'));
      else if (now - session.lastActivity >= idleMs) closing.push(this.close(session, 'idle'));
    }
    await Promise.all(closing);
  }

  /** Close every session of a client, such as when its token is revoked. */
  async closeClient(client: string, reason: CloseReason): Promise<void> {
    await Promise.all(this.list().filter((session) => session.client === client).map((session) => this.close(session, reason)));
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    clearInterval(this.#sweeper);
    this.#slots.refuseWaiting(shuttingDown());
    await Promise.all(this.list().map((session) => this.close(session, 'shutdown')));
  }
}

function shuttingDown(): BrowserctlError {
  return new BrowserctlError('capacity', 'the server is shutting down');
}

/** A session browser over a managed Chrome process. */
export function chromeBrowser(chrome: ChromeProcess): SessionBrowser {
  return {
    cdp: chrome.cdp,
    pid: chrome.pid,
    exit: (timeoutMs) => chrome.requestExit(timeoutMs),
    async stop() {
      // Exiting cleanly flushes the profile; killing the group afterwards removes any process left behind.
      await chrome.requestExit(EXIT_TIMEOUT_MS);
      await chrome.kill();
    },
  };
}
