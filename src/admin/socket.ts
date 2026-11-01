// The admin socket: a Unix socket in the state directory that only the server's user can open. Each connection
// carries one JSON request line and gets one JSON response line.

import { chmod, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { BrowserctlError, errorClassOf, publicMessage, type ErrorClass } from '../errors.ts';

export const SOCKET_NAME = 'admin.sock';
const MAX_REQUEST_BYTES = 64 * 1024;

export type AdminHandler = (args: Record<string, unknown>) => Promise<unknown>;

type Response = { ok: true; result: unknown } | { ok: false; error: string; errorClass: ErrorClass };

export function socketPath(stateDirectory: string): string {
  return join(stateDirectory, SOCKET_NAME);
}

export class AdminServer {
  readonly #handlers = new Map<string, AdminHandler>();
  #server: Server | undefined;

  handle(command: string, handler: AdminHandler): void {
    this.#handlers.set(command, handler);
  }

  async listen(stateDirectory: string): Promise<void> {
    const path = socketPath(stateDirectory);
    await rm(path, { force: true });
    const server = createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('error', () => socket.destroy());
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > MAX_REQUEST_BYTES) return socket.destroy();
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        socket.pause();
        void this.#answer(buffer.slice(0, end)).then((response) => socket.end(`${JSON.stringify(response)}\n`));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => resolve());
    });
    await chmod(path, 0o600);
    this.#server = server;
  }

  async #answer(line: string): Promise<Response> {
    try {
      const request = JSON.parse(line) as { command?: unknown; args?: unknown };
      const handler = typeof request.command === 'string' ? this.#handlers.get(request.command) : undefined;
      if (!handler) throw new BrowserctlError('invalid_request', 'unknown admin command');
      const args = typeof request.args === 'object' && request.args !== null ? (request.args as Record<string, unknown>) : {};
      return { ok: true, result: await handler(args) };
    } catch (error) {
      return { ok: false, error: error instanceof SyntaxError ? 'malformed request' : publicMessage(error), errorClass: errorClassOf(error) };
    }
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Send one admin request to the server and return its result; a refusal throws with the server's message. */
export function adminRequest(stateDirectory: string, command: string, args: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(stateDirectory));
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new BrowserctlError('timeout', 'the server did not answer in time'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ command, args })}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const reason = error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'the server is not running' : 'the admin socket is unavailable';
      reject(new BrowserctlError('internal', reason));
    });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const response = JSON.parse(buffer) as Response;
        if (response.ok) resolve(response.result);
        else reject(new BrowserctlError(response.errorClass, response.error));
      } catch {
        reject(new BrowserctlError('internal', 'the server sent a malformed answer'));
      }
    });
  });
}
