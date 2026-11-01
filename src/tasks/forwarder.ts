// The model forwarder: task runs call POST /v1/responses with a token issued for that run, and the forwarder sends
// the request to the configured model with the model key, which never reaches a run.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { bearerToken } from '../auth/tokens.ts';
import { BrowserctlError } from '../errors.ts';
import { readProtectedFile } from '../config/config.ts';
import { readBody, sendJson, type HttpRouter } from '../server/http.ts';

const PATH = '/v1/responses';
/** Requests carry screenshots; this bounds one. */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 180_000;

export interface ModelConfig {
  baseUrl: string;
  name: string;
  keyFile: string;
}

export class ModelForwarder {
  readonly #model: ModelConfig | undefined;
  readonly #tokens = new Set<string>();

  constructor(model: ModelConfig | undefined) {
    this.#model = model;
  }

  /** The model name task runs ask for, when a model is configured. */
  get modelName(): string | undefined {
    return this.#model?.name;
  }

  /** Issue a token for one run; revoke it when the run ends. */
  issue(): { token: string; revoke: () => void } {
    const token = randomBytes(32).toString('base64url');
    this.#tokens.add(token);
    return { token, revoke: () => void this.#tokens.delete(token) };
  }

  mount(router: HttpRouter): void {
    router.route(PATH, (request, response, url) => this.#forward(request, response, url));
  }

  #authenticated(header: string | undefined): boolean {
    const presented = bearerToken(header);
    if (!presented) return false;
    let found = false;
    for (const token of this.#tokens) {
      const a = Buffer.from(token);
      const b = Buffer.from(presented);
      if (a.length === b.length && timingSafeEqual(a, b)) found = true;
    }
    return found;
  }

  async #forward(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (url.pathname !== PATH || request.method !== 'POST') return sendJson(response, 404, { error: { message: 'not found' } });
    if (!this.#authenticated(request.headers.authorization)) return sendJson(response, 401, { error: { message: 'a valid run token is required' } });
    const model = this.#model;
    if (!model) return sendJson(response, 503, { error: { message: 'no model is configured' } });
    let body: Buffer;
    try {
      const parsed = JSON.parse((await readBody(request, MAX_REQUEST_BYTES)).toString('utf8')) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      // Runs use the configured model, whatever they ask for.
      body = Buffer.from(JSON.stringify({ ...parsed, model: model.name }));
    } catch (error) {
      if (error instanceof BrowserctlError) throw error;
      return sendJson(response, 400, { error: { message: 'the request body is not a JSON object' } });
    }
    let upstream: Response;
    try {
      const key = readProtectedFile(model.keyFile, 'BROWSERCTL_MODEL_KEY_FILE');
      upstream = await fetch(`${model.baseUrl}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': request.headers['content-type'] ?? 'application/json', accept: request.headers.accept ?? '*/*' },
        body: new Uint8Array(body),
        redirect: 'error',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      return sendJson(response, 502, { error: { message: 'the model is unreachable' } });
    }
    const headers: Record<string, string> = { 'cache-control': 'no-store' };
    const type = upstream.headers.get('content-type');
    if (type) headers['content-type'] = type;
    response.writeHead(upstream.status, headers);
    if (!upstream.body) return void response.end();
    await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), response).catch(() => response.destroy());
  }
}
