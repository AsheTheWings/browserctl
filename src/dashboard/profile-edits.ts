import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { CdpConnection } from '../browser/cdp.ts';
import { BrowserctlError, errorClassOf } from '../errors.ts';
import type { LeaseClient, ProviderRevision } from '../providers/lease-client.ts';
import { emitEvent } from '../telemetry/signals.ts';
import { connectBrowser, Screencast, socketViewer } from './screencast.ts';

const HEARTBEAT_MS = 30_000;
const MAX_OPEN_MS = 20 * 60_000;
const DISCARD_DELAY_MS = 15_000;
const MAX_PENDING = 24;
const COMMAND_TIMEOUT_MS = 12_000;

export class ProfileEdit {
  readonly id = randomBytes(18).toString('base64url');
  readonly owner: string;
  readonly name: string;
  readonly provider: string;
  readonly #client: LeaseClient;
  readonly #lease: string;
  readonly #forget: () => void;
  readonly #cast: Screencast;
  readonly #expires: NodeJS.Timeout;
  readonly #heartbeat: NodeJS.Timeout;
  #waiting: NodeJS.Timeout;
  #cdp: CdpConnection | undefined;
  #socket: WebSocket | undefined;
  #finished: Promise<ProviderRevision | undefined> | undefined;
  #beating = false;

  constructor(client: LeaseClient, lease: string, name: string, owner: string, expiresAt: number, forget: () => void) {
    this.#client = client;
    this.provider = client.provider.name;
    this.#lease = lease;
    this.name = name;
    this.owner = owner;
    this.#forget = forget;
    this.#cast = new Screencast(async () => {
      const { url, headers } = client.profileEditBrowser(lease);
      return this.#cdp = await connectBrowser(url, headers);
    });
    this.#cast.onClose(() => this.abandon());
    this.#waiting = setTimeout(() => this.abandon(), DISCARD_DELAY_MS).unref();
    this.#expires = setTimeout(() => this.abandon(), Math.max(0, Math.min(MAX_OPEN_MS, expiresAt - Date.now()))).unref();
    this.#heartbeat = setInterval(() => {
      if (this.#beating || this.#finished) return;
      this.#beating = true;
      void client.heartbeatProfileEdit(lease)
        .catch(() => this.abandon()).finally(() => { this.#beating = false; });
    }, HEARTBEAT_MS).unref();
  }

  attach(socket: WebSocket): void {
    if (this.#socket || this.#finished) return socket.close(1008, 'editor unavailable');
    clearTimeout(this.#waiting);
    this.#socket = socket;
    const unwatch = this.#cast.watch(socketViewer(socket, 'focused'));
    let queued = 0;
    let pending = Promise.resolve();
    socket.on('message', (data, binary) => {
      if (binary || data.toString().length > 8192 || queued >= MAX_PENDING) return socket.close(1008, 'input limit');
      queued++;
      pending = pending.then(async () => {
        if (this.#finished || socket.readyState !== socket.OPEN) return;
        let value: unknown;
        try { value = JSON.parse(data.toString()); } catch { return; }
        try { await this.#input(value); } catch {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ error: 'The browser could not apply that input.' }));
        }
      }).finally(() => { queued--; });
    });
    socket.once('close', () => {
      unwatch();
      this.abandon();
    });
  }

  abandon(): void {
    void this.finish(false).catch((error: unknown) => {
      if (errorClassOf(error) === 'not_found') return;
      emitEvent('browserctl.lease.failed', {
        'browserctl.provider': this.#client.provider.name,
        'browserctl.lease.operation': 'profiles',
        'error.type': errorClassOf(error),
      });
    });
  }

  finish(save: boolean): Promise<ProviderRevision | undefined> {
    if (save && (!this.#socket || this.#socket.readyState !== this.#socket.OPEN)) {
      throw new BrowserctlError('conflict', 'the profile editor is not connected');
    }
    if (save && this.#finished) throw new BrowserctlError('conflict', 'the profile editor is closing');
    if (this.#finished) return this.#finished;
    this.#finished = Promise.resolve().then(async () => {
      clearTimeout(this.#waiting);
      clearTimeout(this.#expires);
      clearInterval(this.#heartbeat);
      this.#cast.close();
      this.#socket?.close(1001, 'editor finished');
      try {
        if (save) return await this.#client.saveProfileEdit(this.#lease);
        await this.#client.discardProfileEdit(this.#lease);
      } finally {
        this.#forget();
      }
    });
    return this.#finished;
  }

  async #input(value: unknown): Promise<void> {
    const cdp = this.#cdp;
    const page = this.#cast.pageSession;
    if (!value || typeof value !== 'object') return;
    if (!cdp || !page) throw new Error('browser page is not ready');
    const input = value as Record<string, unknown>;
    const call = (method: string, params: Record<string, unknown> = {}) => {
      const timeout = setTimeout(() => cdp.close(), COMMAND_TIMEOUT_MS).unref();
      return cdp.call(method, params, page).finally(() => clearTimeout(timeout));
    };
    if (input.type === 'navigate' && typeof input.url === 'string' && input.url.length <= 2048) {
      const url = new URL(input.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid navigation');
      const result = await call('Page.navigate', { url: url.href });
      if (result.errorText) throw new Error('navigation failed');
    } else if (input.type === 'text' && typeof input.text === 'string' && input.text.length <= 4096) {
      await call('Input.insertText', { text: input.text });
    } else if (input.type === 'key' && typeof input.key === 'string' && input.key.length <= 32
      && typeof input.code === 'string' && input.code.length <= 32 && Number.isInteger(input.modifiers)
      && Number(input.modifiers) >= 0 && Number(input.modifiers) <= 15
      && Number.isInteger(input.keyCode) && Number(input.keyCode) >= 0 && Number(input.keyCode) <= 255) {
      const { key, code, modifiers, keyCode } = input;
      const options = { key, code, modifiers, windowsVirtualKeyCode: keyCode };
      const text = [...key].length === 1 && !(Number(modifiers) & 7) ? key : undefined;
      await call('Input.dispatchKeyEvent', { ...options, type: text ? 'keyDown' : 'rawKeyDown', text });
      await call('Input.dispatchKeyEvent', { ...options, type: 'keyUp' });
    } else if ((input.type === 'click' || input.type === 'wheel') && fractional(input.x) && fractional(input.y)) {
      const { cssVisualViewport } = await call('Page.getLayoutMetrics');
      const view = cssVisualViewport as { clientWidth?: number; clientHeight?: number } | undefined;
      if (!view?.clientWidth || !view.clientHeight) return;
      const x = Math.min(view.clientWidth - 1, input.x * view.clientWidth);
      const y = Math.min(view.clientHeight - 1, input.y * view.clientHeight);
      if (input.type === 'click') {
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      } else if (typeof input.dx === 'number' && typeof input.dy === 'number') {
        const limit = (n: number) => Math.max(-2000, Math.min(2000, n));
        await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: limit(input.dx), deltaY: limit(input.dy) });
      }
    }
  }
}

function fractional(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1;
}
