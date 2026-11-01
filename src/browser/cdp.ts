// One CDP connection to a browser: commands with replies, events, and forwarding of other clients' messages.

import { BrowserctlError } from '../errors.ts';

export interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  sessionId?: string;
}

/** Carries serialized CDP messages to and from a browser. */
export interface CdpTransport {
  send(text: string): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

type Pending = (message: CdpMessage) => void;

export class CdpConnection {
  readonly #transport: CdpTransport;
  readonly #pending = new Map<number, Pending>();
  readonly #eventListeners = new Set<(message: CdpMessage) => void>();
  readonly #closeListeners = new Set<() => void>();
  #nextId = 1;
  #closed = false;

  constructor(transport: CdpTransport) {
    this.#transport = transport;
    transport.onMessage((text) => this.#receive(text));
    transport.onClose(() => this.#close());
  }

  get closed(): boolean {
    return this.#closed;
  }

  #receive(text: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(text) as CdpMessage;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      pending?.(message);
      return;
    }
    for (const listener of this.#eventListeners) listener(message);
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending({ id, error: { code: -32000, message: 'browser connection closed' } });
    }
    for (const listener of this.#closeListeners) listener();
  }

  /** Send a message with a fresh id; the reply, whatever it holds, reaches onReply in arrival order with events. */
  forward(message: Omit<CdpMessage, 'id'>, onReply: (reply: CdpMessage) => void): void {
    if (this.#closed) {
      onReply({ error: { code: -32000, message: 'browser connection closed' } });
      return;
    }
    const id = this.#nextId++;
    this.#pending.set(id, onReply);
    this.#transport.send(JSON.stringify({ ...message, id }));
  }

  /** Send a message with a fresh id and receive its reply, whatever it holds. */
  exchange(message: Omit<CdpMessage, 'id'>): Promise<CdpMessage> {
    return new Promise((resolve) => this.forward(message, resolve));
  }

  /** Run a command and return its result; a CDP error rejects. */
  async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const reply = await this.exchange({ method, params, ...(sessionId !== undefined && { sessionId }) });
    if (reply.error) throw new BrowserctlError('browser_failed', `browser command ${method} failed`);
    return (reply.result ?? {}) as T;
  }

  onEvent(listener: (message: CdpMessage) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  onClose(listener: () => void): void {
    if (this.#closed) listener();
    else this.#closeListeners.add(listener);
  }

  close(): void {
    this.#transport.close();
    this.#close();
  }
}
