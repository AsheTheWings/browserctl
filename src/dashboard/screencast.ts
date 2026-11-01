// Live views of browsers: one CDP screencast of a browser's active page, fanned out to the dashboard's viewers, each
// at its own frame rate. The screencast client sends only the commands a screencast needs, so it can watch a browser
// it must not drive, such as another owner's provider browser.

import { WebSocket } from 'ws';
import { CdpConnection, type CdpMessage, type CdpTransport } from '../browser/cdp.ts';
import { instrument } from '../telemetry/signals.ts';

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

/** A viewer's frame interval: grid tiles at about 5 frames per second, focused views at every frame Chrome sends. */
export const STREAM_INTERVAL_MS: Record<Stream, number> = { grid: 200, focused: 0, recording: 0 };

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
export async function connectBrowser(url: string): Promise<CdpConnection> {
  const socket = new WebSocket(url, { maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false, followRedirects: false, handshakeTimeout: 20_000 });
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
  /** Created after the screencast started, such as a tab an agent opened, which takes the view at once. */
  fresh: boolean;
  lastFrame: number;
}

/**
 * One browser's screencast. Every open page is screencast, and the view shows one: a page opened while watching
 * as soon as it paints, otherwise the page shown so far while it keeps painting, else the page that painted last.
 * Chrome paints only visible pages, so the view follows the tab a person or agent looks at. The screencast starts
 * when its first viewer arrives and stops when its last leaves.
 */
export class Screencast {
  readonly #connect: () => Promise<CdpConnection>;
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

  constructor(connect: () => Promise<CdpConnection>) {
    this.#connect = connect;
  }

  get viewers(): number {
    return this.#viewers.size;
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
    await this.#call('Target.setDiscoverTargets', { discover: true });
    this.#discovered = true;
  }

  #stop(): void {
    const cdp = this.#cdp;
    this.#cdp = undefined;
    this.#pages.clear();
    this.#current = undefined;
    cdp?.close();
  }

  #event(cdp: CdpConnection, event: CdpMessage): void {
    if (cdp !== this.#cdp) return;
    const params = (event.params ?? {}) as Record<string, any>;
    switch (event.method) {
      case 'Target.targetCreated': {
        const targetId = params.targetInfo?.targetId;
        if (params.targetInfo?.type !== 'page' || typeof targetId !== 'string' || this.#pages.has(targetId)) return;
        const page: Page = { sessionId: undefined, fresh: this.#discovered, lastFrame: 0 };
        this.#pages.set(targetId, page);
        void this.#attach(cdp, targetId, page);
        return;
      }
      case 'Target.targetDestroyed':
        this.#pages.delete(params.targetId);
        if (this.#current === params.targetId) this.#current = undefined;
        return;
      case 'Page.screencastFrame': {
        const entry = [...this.#pages.entries()].find(([, page]) => page.sessionId === event.sessionId);
        if (!entry) return;
        void this.#call('Page.screencastFrameAck', { sessionId: params.sessionId }, event.sessionId).catch(() => undefined);
        const [targetId, page] = entry;
        const now = Date.now();
        page.lastFrame = now;
        const current = this.#current === undefined ? undefined : this.#pages.get(this.#current);
        if (page.fresh || !current || now - current.lastFrame > QUIET_MS) {
          page.fresh = false;
          this.#current = targetId;
        }
        if (this.#current !== targetId) return;
        this.#frame({ jpeg: Buffer.from(String(params.data), 'base64'), timestamp: Math.round(Number(params.metadata?.timestamp ?? now / 1000) * 1000) });
        return;
      }
    }
  }

  async #attach(cdp: CdpConnection, targetId: string, page: Page): Promise<void> {
    try {
      const { sessionId } = (await this.#call('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
      if (cdp !== this.#cdp || this.#pages.get(targetId) !== page) return;
      page.sessionId = sessionId;
      await this.#call('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: MAX_WIDTH, maxHeight: MAX_HEIGHT, everyNthFrame: 1 }, sessionId);
    } catch {
      // The page closed while it was being attached.
    }
  }

  #frame(frame: Frame): void {
    this.#last = frame;
    for (const viewer of this.#viewers.keys()) this.#deliver(viewer, frame);
  }

  #deliver(viewer: Viewer, frame: Frame): void {
    const due = this.#viewers.get(viewer) ?? 0;
    const now = Date.now();
    if (now < due) return;
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
