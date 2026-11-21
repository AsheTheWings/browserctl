// Live views of browsers: one CDP screencast of a browser's active page, fanned out to the dashboard's viewers and
// the session's recorder, each at its own frame rate. The screencast client sends only the commands a screencast
// needs, so it can watch a browser it must not drive, such as another owner's provider browser.

import { WebSocket } from 'ws';
import { CdpConnection, type CdpMessage, type CdpTransport } from '../browser/cdp.ts';
import { BrowserctlError } from '../errors.ts';
import type { Providers } from '../providers/external.ts';
import { isPrivateProviderSession, type Session, type SessionManager } from '../sessions/manager.ts';
import { emitEvent, inSpan, instrument } from '../telemetry/signals.ts';

/** The only commands a screencast client sends. */
export const SCREENCAST_COMMANDS = new Set([
  'Target.setDiscoverTargets',
  'Target.attachToTarget',
  'Target.detachFromTarget',
  'Page.startScreencast',
  'Page.screencastFrameAck',
  'Page.stopScreencast',
]);

const MAX_WIDTH = 1280;
const MAX_HEIGHT = 1280;
const QUALITY = 60;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** A viewer whose socket holds more than this is skipped until it drains, so a slow viewer never queues frames. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

export type Stream = 'grid' | 'focused' | 'recording';

/**
 * A viewer's frame interval: grid tiles at about 5 frames per second, recordings at most 10, and focused views at
 * every frame Chrome sends.
 */
export const STREAM_INTERVAL_MS: Record<Stream, number> = { grid: 200, focused: 0, recording: 100 };

export interface Frame {
  jpeg: Buffer;
  /** When Chrome captured the frame, in milliseconds since the epoch. */
  timestamp: number;
}

export interface Viewer {
  stream: Stream;
  /** Deliver a frame; returns false when the viewer cannot take one now. */
  send(frame: Frame): boolean;
}

/** A CDP transport over a browser-level debugging WebSocket. */
function socketTransport(socket: WebSocket): CdpTransport {
  const listeners: Array<(text: string) => void> = [];
  const closers: Array<() => void> = [];
  socket.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const text = raw.toString();
    for (const listener of listeners) listener(text);
  });
  const closed = () => closers.splice(0).forEach((closer) => closer());
  socket.on('close', closed);
  socket.on('error', closed);
  return {
    send: (text) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    },
    onMessage: (listener) => listeners.push(listener),
    onClose: (listener) => closers.push(listener),
    close: () => socket.close(),
  };
}

/** Open a browser-level debugging WebSocket and wrap it as a CDP connection. */
export async function connectBrowser(url: string, headers?: Record<string, string>): Promise<CdpConnection> {
  const socket = new WebSocket(url, { headers, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false, followRedirects: false, handshakeTimeout: 20_000 });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return new CdpConnection(socketTransport(socket));
}

/** A page that sent no frame for this long yields the view to a page that is painting. */
const QUIET_MS = 1_000;

interface Page {
  sessionId: string | undefined;
  url: string | undefined;
  navigation: number;
  capture: 'idle' | 'starting' | 'started';
  visible?: boolean;
  /** Newly opened or newly visible, so its first frame can take the view. */
  fresh: boolean;
  lastFrame: number;
}

/**
 * One browser's screencast. Chrome's visibility events keep the view on the foreground tab. When several pages
 * are visible or visibility is unknown, recently opened or painting pages can take the view. The screencast
 * starts when its first viewer arrives and stops when its last leaves.
 */
export class Screencast {
  readonly #connect: () => Promise<CdpConnection>;
  readonly #id: string | undefined;
  readonly #viewers = new Map<Viewer, number>();
  #cdp: CdpConnection | undefined;
  #starting: Promise<void> | undefined;
  readonly #pages = new Map<string, Page>();
  /** Set once discovery has reported the pages that were open when the screencast started. */
  #discovered = false;
  #current: string | undefined;
  #last: Frame | undefined;
  #closed = false;
  readonly #closeListeners: Array<() => void> = [];

  constructor(connect: () => Promise<CdpConnection>, id?: string) {
    this.#connect = connect;
    this.#id = id;
  }

  get viewers(): number {
    return this.#viewers.size;
  }

  /** The page shown to the viewer, or the first attached page before its first frame. */
  get pageSession(): string | undefined {
    if (this.#current !== undefined) return this.#pages.get(this.#current)?.sessionId;
    return [...this.#pages.values()].find(({ sessionId }) => sessionId)?.sessionId;
  }

  /** Add a viewer, which gets the latest frame at once; returns a function that removes it. */
  watch(viewer: Viewer): () => void {
    this.#viewers.set(viewer, 0);
    if (this.#last) this.#deliver(viewer, this.#last);
    if (!this.#cdp && !this.#starting) {
      this.#starting = this.#start().finally(() => (this.#starting = undefined));
      this.#starting.catch(() => this.close());
    }
    return () => {
      this.#viewers.delete(viewer);
      if (this.#viewers.size === 0) this.#stop();
    };
  }

  /** End the screencast for good, such as when its browser goes away. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#viewers.clear();
    this.#stop();
    for (const listener of this.#closeListeners.splice(0)) listener();
  }

  /** Call a listener when the screencast ends for good. */
  onClose(listener: () => void): void {
    if (this.#closed) listener();
    else this.#closeListeners.push(listener);
  }

  get closed(): boolean {
    return this.#closed;
  }

  #call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (!SCREENCAST_COMMANDS.has(method)) throw new Error(`a screencast client never sends ${method}`);
    return this.#cdp!.call(method, params, sessionId);
  }

  async #start(): Promise<void> {
    const cdp = await this.#connect();
    if (this.#closed || this.#viewers.size === 0) {
      cdp.close();
      return;
    }
    this.#cdp = cdp;
    this.#discovered = false;
    cdp.onClose(() => {
      if (this.#cdp === cdp) this.close();
    });
    cdp.onEvent((event) => this.#event(cdp, event));
    // Discovery reports every open target as created before it answers, then each later change.
    await inSpan('browserctl.screencast.capture_start', {
      'browserctl.session.id': this.#id,
      'browserctl.screencast.stage': 'discover',
    }, () => this.#call('Target.setDiscoverTargets', { discover: true }));
    this.#discovered = true;
  }

  #stop(): void {
    const cdp = this.#cdp;
    this.#cdp = undefined;
    this.#pages.clear();
    this.#current = undefined;
    this.#last = undefined;
    cdp?.close();
  }

  #event(cdp: CdpConnection, event: CdpMessage): void {
    if (cdp !== this.#cdp) return;
    const params = (event.params ?? {}) as Record<string, any>;
    switch (event.method) {
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged': {
        const targetId = params.targetInfo?.targetId;
        if (params.targetInfo?.type !== 'page' || typeof targetId !== 'string') return;
        const url = typeof params.targetInfo.url === 'string' ? params.targetInfo.url : undefined;
        const existing = this.#pages.get(targetId);
        if (existing) {
          if (existing.url !== url) {
            existing.url = url;
            existing.navigation++;
            void this.#startPage(cdp, targetId, existing);
          }
          return;
        }
        const page: Page = { sessionId: undefined, url, navigation: 0, capture: 'idle', fresh: this.#discovered, lastFrame: 0 };
        this.#pages.set(targetId, page);
        void this.#startPage(cdp, targetId, page);
        return;
      }
      case 'Target.targetDestroyed':
        this.#pages.delete(params.targetId);
        this.#clearSelection(params.targetId);
        return;
      case 'Page.screencastVisibilityChanged': {
        const entry = this.#pageForEvent(event);
        if (!entry || typeof params.visible !== 'boolean') return;
        const [targetId, page] = entry;
        if (page.visible === false && params.visible) page.fresh = true;
        page.visible = params.visible;
        if (!page.visible) this.#clearSelection(targetId);
        return;
      }
      case 'Page.screencastFrame': {
        const entry = this.#pageForEvent(event);
        if (!entry) return;
        void this.#call('Page.screencastFrameAck', { sessionId: params.sessionId }, event.sessionId).catch(() => undefined);
        const [targetId, page] = entry;
        if (page.visible === false) return;
        const now = Date.now();
        page.lastFrame = now;
        const current = this.#current === undefined ? undefined : this.#pages.get(this.#current);
        const changed = this.#current !== targetId;
        if (changed) {
          if (current?.visible && page.visible === undefined) return;
          if (current && page.visible === current.visible && !page.fresh && now - current.lastFrame <= QUIET_MS) return;
          this.#current = targetId;
          emitEvent('browserctl.screencast.tab_selected', {
            'browserctl.session.id': this.#id,
            'browserctl.screencast.visibility': page.visible ? 'visible' : 'unknown',
          }, 'info');
        }
        page.fresh = false;
        this.#frame({ jpeg: Buffer.from(String(params.data), 'base64'), timestamp: Math.round(Number(params.metadata?.timestamp ?? now / 1000) * 1000) }, changed);
        return;
      }
    }
  }

  #pageForEvent(event: CdpMessage): [string, Page] | undefined {
    if (!event.sessionId) return undefined;
    return [...this.#pages].find(([, page]) => page.sessionId === event.sessionId);
  }

  #clearSelection(targetId: string): void {
    if (this.#current !== targetId) return;
    this.#current = undefined;
    this.#last = undefined;
  }

  async #startPage(cdp: CdpConnection, targetId: string, page: Page): Promise<void> {
    if (page.capture !== 'idle' || cdp !== this.#cdp || this.#pages.get(targetId) !== page) return;
    const navigation = page.navigation;
    page.capture = 'starting';
    try {
      await inSpan('browserctl.screencast.capture_start', {
        'browserctl.session.id': this.#id,
        'browserctl.screencast.stage': page.sessionId === undefined ? 'attach' : 'start',
      }, async (span) => {
        if (page.sessionId === undefined) {
          const { sessionId } = await this.#call('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
          if (cdp !== this.#cdp || this.#pages.get(targetId) !== page) return;
          page.sessionId = sessionId;
        }
        span.setAttribute('browserctl.screencast.stage', 'start');
        const reply = await cdp.exchange({
          method: 'Page.startScreencast', sessionId: page.sessionId,
          params: { format: 'jpeg', quality: QUALITY, maxWidth: MAX_WIDTH, maxHeight: MAX_HEIGHT, everyNthFrame: 1 },
        });
        if (reply.error) {
          const reason = reply.error.message === 'Not attached to an active page' ? 'inactive_page'
            : reply.error.message === 'Screencast is already active' ? 'already_active'
            : cdp.closed ? 'disconnected' : 'other';
          span.setAttribute('browserctl.screencast.rejection', reason);
          throw new BrowserctlError('browser_failed', 'browser command Page.startScreencast failed');
        }
        page.capture = 'started';
      });
    } catch {
      // A navigation can make Chrome reject capture startup and change the target before the error arrives.
      page.capture = 'idle';
      if (page.navigation !== navigation) void this.#startPage(cdp, targetId, page);
    }
  }

  #frame(frame: Frame, tabChanged: boolean): void {
    this.#last = frame;
    for (const viewer of this.#viewers.keys()) this.#deliver(viewer, frame, tabChanged && viewer.stream === 'grid');
  }

  #deliver(viewer: Viewer, frame: Frame, force = false): void {
    const due = this.#viewers.get(viewer) ?? 0;
    const now = Date.now();
    if (!force && now < due) return;
    if (viewer.send(frame)) {
      this.#viewers.set(viewer, now + STREAM_INTERVAL_MS[viewer.stream]);
      instrument().frames.add(1, { 'browserctl.stream': viewer.stream });
    }
  }
}

/** A viewer over a dashboard WebSocket: each frame is one binary message holding the JPEG. */
export function socketViewer(socket: WebSocket, stream: Stream): Viewer {
  return {
    stream,
    send(frame) {
      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_BUFFERED_BYTES) return false;
      socket.send(frame.jpeg, { binary: true });
      return true;
    },
  };
}

const WATCH_SWEEP_MS = 5_000;
/** A watched browser's id: another owner's provider slot. */
export const WATCHED = /^w-([a-z][a-z0-9-]{0,62})-([0-9]{1,6})$/;

/**
 * The screencast of each session and watched browser, shared by everything that views it. A sign-in session has
 * none: its view is its display.
 */
export class Screencasts {
  readonly #sessions: SessionManager;
  readonly #providers: Providers;
  readonly #screencasts = new Map<string, Screencast>();
  #sweeper: NodeJS.Timeout | undefined;

  constructor(sessions: SessionManager, providers: Providers) {
    this.#sessions = sessions;
    this.#providers = providers;
  }

  start(): void {
    // A provider slot another owner released may be leased again by anyone, so its watcher stops with the lease.
    this.#sweeper = setInterval(() => {
      for (const [id, screencast] of this.#screencasts) {
        const watched = WATCHED.exec(id);
        if (watched && !this.#providers.watchTarget(watched[1]!, Number(watched[2]))) screencast.close();
      }
    }, WATCH_SWEEP_MS);
    this.#sweeper.unref();
  }

  stop(): void {
    clearInterval(this.#sweeper);
    for (const screencast of this.#screencasts.values()) screencast.close();
  }

  /** The screencast of a live session or a watched browser, by its id. */
  get(id: string): Screencast | undefined {
    const session = this.#sessions.get(id);
    return session ? this.forSession(session) : this.#watched(id);
  }

  /** A ready agent or check session's screencast, over a capability whose traffic leaves the session idle. */
  forSession(session: Session): Screencast | undefined {
    if (isPrivateProviderSession(session)) return undefined;
    if (session.purpose === 'sign_in' || session.state !== 'ready' || !session.registration) return undefined;
    return this.#shared(session.id, () => {
      const screencast = new Screencast(async () => {
        const { endpoint, release } = this.#sessions.watchEndpoint(session);
        try {
          const cdp = await connectBrowser(`${endpoint.replace(/^http/, 'ws')}/devtools/browser`);
          cdp.onClose(release);
          return cdp;
        } catch (error) {
          release();
          throw error;
        }
      }, session.id);
      void session.closed.then(() => screencast.close());
      return screencast;
    });
  }

  #watched(id: string): Screencast | undefined {
    const watched = WATCHED.exec(id);
    const target = watched ? this.#providers.watchTarget(watched[1]!, Number(watched[2])) : undefined;
    if (!target) return undefined;
    return this.#shared(id, () => new Screencast(async () => connectBrowser(await target.socketUrl()), id));
  }

  #shared(id: string, create: () => Screencast): Screencast {
    const existing = this.#screencasts.get(id);
    if (existing && !existing.closed) return existing;
    const screencast = create();
    this.#screencasts.set(id, screencast);
    screencast.onClose(() => {
      if (this.#screencasts.get(id) === screencast) this.#screencasts.delete(id);
    });
    return screencast;
  }
}
