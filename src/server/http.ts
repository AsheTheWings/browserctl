// The server's one HTTP listener: routes by path prefix for requests and WebSocket upgrades.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { BrowserctlError, errorClassOf, publicMessage } from '../errors.ts';

export type RequestHandler = (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void> | void;
export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer, url: URL) => void;

const STATUS: Record<string, number> = {
  capacity: 503,
  invalid_request: 400,
  not_found: 404,
  unauthorized: 401,
  conflict: 409,
  timeout: 504,
  model_unavailable: 503,
};

export function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', ...headers });
  response.end(text);
}

export function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const errorClass = errorClassOf(error);
  sendJson(response, STATUS[errorClass] ?? 500, { error: publicMessage(error), errorClass });
}

export function notFound(response: ServerResponse): void {
  sendError(response, new BrowserctlError('not_found', 'not found'));
}

/** Refuse an upgrade with a bare HTTP status line. */
export function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Read a request body up to a limit; a larger body is refused. */
export async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new BrowserctlError('invalid_request', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export class HttpRouter {
  readonly #routes: Array<{ prefix: string; handler: RequestHandler }> = [];
  readonly #upgrades: Array<{ prefix: string; handler: UpgradeHandler }> = [];
  #server: Server | undefined;

  /** Route requests whose path equals the prefix or starts with it followed by a slash. */
  route(prefix: string, handler: RequestHandler): void {
    this.#routes.push({ prefix, handler });
    this.#routes.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  upgrade(prefix: string, handler: UpgradeHandler): void {
    this.#upgrades.push({ prefix, handler });
    this.#upgrades.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  #match<T extends { prefix: string }>(entries: T[], path: string): T | undefined {
    return entries.find(({ prefix }) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
  }

  async listen(address: string, port: number): Promise<number> {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://browserctl.invalid');
      const route = this.#match(this.#routes, url.pathname);
      if (!route) return notFound(response);
      Promise.resolve()
        .then(() => route.handler(request, response, url))
        .catch((error: unknown) => sendError(response, error));
    });
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on('error', () => socket.destroy());
      const url = new URL(request.url ?? '/', 'http://browserctl.invalid');
      const route = this.#match(this.#upgrades, url.pathname);
      if (!route) return refuseUpgrade(socket, 404, 'Not Found');
      try {
        route.handler(request, socket, head, url);
      } catch {
        refuseUpgrade(socket, 500, 'Internal Server Error');
      }
    });
    server.headersTimeout = 30_000;
    server.requestTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, address, () => resolve());
    });
    this.#server = server;
    const bound = server.address();
    return typeof bound === 'object' && bound ? bound.port : port;
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}
