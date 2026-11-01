// The agent MCP endpoint: streamable HTTP at /mcp, one MCP connection per client session id, each binding at most
// one browser session whose Playwright MCP worker serves the allowlisted browser tools.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { AuditLog } from '../audit.ts';
import { bearerToken, type TokenStore } from '../auth/tokens.ts';
import { BrowserctlError, publicMessage } from '../errors.ts';
import type { ProfileStore } from '../profiles/store.ts';
import { sendJson, type HttpRouter } from '../server/http.ts';
import { getFile, MAX_FILE_BYTES, putFile } from '../sessions/files.ts';
import { sourceLabel, type Session, type SessionManager, type Source } from '../sessions/manager.ts';
import type { TaskRunner } from '../tasks/runner.ts';
import type { TaskStore } from '../tasks/store.ts';
import { inSpan } from '../telemetry/signals.ts';
import { ALLOWED_TOOLS, playwrightTools } from './allowlist.ts';
import { readGuide, GUIDES } from './guides.ts';
import { PlaywrightWorker } from './worker-client.ts';

/** A base64 file of 25 MiB inside a JSON-RPC request, with room for the envelope. */
const MAX_BODY_BYTES = Math.ceil((MAX_FILE_BYTES * 4) / 3) + 1024 * 1024;

export interface EndpointOptions {
  tokens: TokenStore;
  sessions: SessionManager;
  profiles: ProfileStore;
  tasks: TaskStore;
  runner: TaskRunner;
  audit: AuditLog;
  path: string;
  version: string;
  /** A connection without a bound session and without requests for this long is dropped. */
  idleSeconds: number;
}

const SWEEP_INTERVAL_MS = 60_000;

interface Connection {
  id: string;
  client: string;
  transport: StreamableHTTPServerTransport;
  server: Server;
  session: Session | undefined;
  worker: PlaywrightWorker | undefined;
  /** Set while session_open runs, so a second one fails instead of racing it. */
  opening: boolean;
  lastSeen: number;
}

const object = (properties: Record<string, unknown>, required: string[] = []): Tool['inputSchema'] => ({
  type: 'object',
  properties: properties as Tool['inputSchema']['properties'],
  required,
  additionalProperties: false,
});

const SESSION_TOOLS: Tool[] = [
  { name: 'profiles_list', description: 'List the browser profiles sessions can start from.', inputSchema: object({}) },
  {
    name: 'session_open',
    description:
      'Open a browser session and bind it to this connection. Give exactly one of profile (start from a copy of that profile), ' +
      'ephemeral: true (start from an empty profile), or provider (an external browser, with an optional slot).',
    inputSchema: object({
      profile: { type: 'string' },
      ephemeral: { type: 'boolean', const: true },
      provider: { type: 'string' },
      slot: { type: 'integer', minimum: 0 },
    }),
  },
  { name: 'session_close', description: 'Close the bound session.', inputSchema: object({}) },
  { name: 'session_status', description: 'Describe the bound session, if any.', inputSchema: object({}) },
  {
    name: 'session_file_put',
    description: `Write a file of at most ${MAX_FILE_BYTES} bytes into the session's uploads/ area, for browser_file_upload.`,
    inputSchema: object({ name: { type: 'string' }, content_base64: { type: 'string' } }, ['name', 'content_base64']),
  },
  {
    name: 'session_file_get',
    description: `Read a file of at most ${MAX_FILE_BYTES} bytes from the session's file area, such as a download or screenshot.`,
    inputSchema: object({ name: { type: 'string' } }, ['name']),
  },
  { name: 'task_list', description: 'List the saved tasks and their latest revisions.', inputSchema: object({}) },
  {
    name: 'task_get',
    description: 'Read a task revision: its e2e test file and who saved it. Without a revision, the latest.',
    inputSchema: object({ name: { type: 'string' }, revision: { type: 'string' } }, ['name']),
  },
  {
    name: 'task_save',
    description:
      'Save an e2e test file as a new revision of a task, creating the task if it is new. Read the browserctl://guides/tasks resource ' +
      'for the task contract and the e2e guides for writing the test.',
    inputSchema: object({ name: { type: 'string' }, content: { type: 'string' } }, ['name', 'content']),
  },
  {
    name: 'task_run',
    description:
      "Run a task revision (the latest without one) against the bound session's browser with a JSON input, and return its status, " +
      'output, and failure summary. Browser tools on the session are refused while the run drives it.',
    inputSchema: object({ name: { type: 'string' }, revision: { type: 'string' }, input: {} }, ['name']),
  },
];
const SESSION_TOOL_NAMES = new Set(SESSION_TOOLS.map((tool) => tool.name));

function text(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function refusal(error: unknown): CallToolResult {
  return { content: [{ type: 'text', text: publicMessage(error) }], isError: true };
}

function optionalRevision(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[0-9]{1,12}$/.test(value)) throw new BrowserctlError('invalid_request', 'a revision is a number');
  return value;
}

function sourceOf(args: Record<string, unknown>): Source {
  const given = ['profile', 'ephemeral', 'provider'].filter((key) => args[key] !== undefined);
  if (given.length !== 1) throw new BrowserctlError('invalid_request', 'give exactly one of profile, ephemeral, or provider');
  if (args.slot !== undefined && args.provider === undefined) throw new BrowserctlError('invalid_request', 'slot needs a provider');
  if (args.profile !== undefined) {
    if (typeof args.profile !== 'string') throw new BrowserctlError('invalid_request', 'profile must be a name');
    return { kind: 'profile', profile: args.profile };
  }
  if (args.ephemeral !== undefined) {
    if (args.ephemeral !== true) throw new BrowserctlError('invalid_request', 'ephemeral must be true');
    return { kind: 'ephemeral' };
  }
  if (typeof args.provider !== 'string') throw new BrowserctlError('invalid_request', 'provider must be a name');
  if (args.slot !== undefined && (!Number.isInteger(args.slot) || (args.slot as number) < 0)) {
    throw new BrowserctlError('invalid_request', 'slot must be a non-negative integer');
  }
  return { kind: 'provider', provider: args.provider, ...(args.slot !== undefined && { slot: args.slot as number }) };
}

export class McpEndpoint {
  readonly #options: EndpointOptions;
  readonly #connections = new Map<string, Connection>();
  #sweeper: NodeJS.Timeout | undefined;

  constructor(options: EndpointOptions) {
    this.#options = options;
    options.sessions.onClose((session) => {
      for (const connection of this.#connections.values()) {
        if (connection.session === session) this.#unbind(connection);
      }
    });
  }

  mount(router: HttpRouter): void {
    router.route('/mcp', (request, response, url) => this.#handle(request, response, url));
    this.#sweeper = setInterval(() => void this.sweep(Date.now()), SWEEP_INTERVAL_MS);
    this.#sweeper.unref();
  }

  /** Drop connections that bind no session and have been idle past the idle timeout. */
  async sweep(now: number): Promise<void> {
    const idleMs = this.#options.idleSeconds * 1000;
    const idle = [...this.#connections.values()].filter((entry) => !entry.session && !entry.opening && now - entry.lastSeen >= idleMs);
    await Promise.all(idle.map((entry) => this.#drop(entry)));
  }

  /** How many MCP connections are open. */
  get size(): number {
    return this.#connections.size;
  }

  /** Drop every connection of a client, such as when its token is revoked. */
  async closeClient(client: string): Promise<void> {
    await Promise.all([...this.#connections.values()].filter((entry) => entry.client === client).map((entry) => this.#drop(entry)));
  }

  async stop(): Promise<void> {
    clearInterval(this.#sweeper);
    await Promise.all([...this.#connections.values()].map((entry) => this.#drop(entry)));
  }

  async #handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (url.pathname !== '/mcp') return sendJson(response, 404, { error: 'not found', errorClass: 'not_found' });
    const client = this.#options.tokens.authenticate(bearerToken(request.headers.authorization));
    if (!client) {
      return sendJson(response, 401, { error: 'a valid client token is required', errorClass: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    }
    const header = request.headers['mcp-session-id'];
    const id = typeof header === 'string' ? header : undefined;
    let connection: Connection | undefined;
    if (id !== undefined) {
      connection = this.#connections.get(id);
      // Another client's connection id is answered like an unknown one.
      if (!connection || connection.client !== client) {
        return sendJson(response, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
      }
    }
    let body: unknown;
    if (request.method === 'POST') {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) return sendJson(response, 413, { error: 'request body too large', errorClass: 'invalid_request' });
        chunks.push(chunk as Buffer);
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return sendJson(response, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      }
    }
    connection ??= await this.#connect(client);
    connection.lastSeen = Date.now();
    if (connection.session) this.#options.sessions.touch(connection.session);
    await connection.transport.handleRequest(request, response, body);
  }

  async #connect(client: string): Promise<Connection> {
    const server = new Server({ name: 'browserctl', version: this.#options.version }, { capabilities: { tools: {}, resources: {} } });
    const connection: Connection = {
      id: '',
      client,
      server,
      session: undefined,
      worker: undefined,
      opening: false,
      lastSeen: Date.now(),
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(24).toString('base64url'),
        onsessioninitialized: (id) => {
          connection.id = id;
          this.#connections.set(id, connection);
        },
        onsessionclosed: () => void this.#drop(connection),
      }),
    };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...SESSION_TOOLS, ...(await playwrightTools())] }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => this.#call(connection, request.params.name, request.params.arguments ?? {}));
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: GUIDES.map(({ uri, name, description }) => ({ uri, name, description, mimeType: 'text/markdown' })),
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
      contents: [{ uri: request.params.uri, mimeType: 'text/markdown', text: await readGuide(request.params.uri) }],
    }));
    await server.connect(connection.transport);
    return connection;
  }

  #call(connection: Connection, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const known = SESSION_TOOL_NAMES.has(name) || ALLOWED_TOOLS.has(name);
    const attributes = { 'browserctl.tool': known ? name : 'unknown', ...(connection.session && { 'browserctl.session.id': connection.session.id }) };
    return inSpan('browserctl.mcp.tool_call', attributes, async () => {
      if (!known) throw new BrowserctlError('not_found', `unknown tool ${name}`);
      if (connection.session) this.#options.sessions.touch(connection.session);
      if (SESSION_TOOL_NAMES.has(name)) return this.#sessionTool(connection, name, args);
      const { session, worker } = this.#bound(connection);
      if (this.#options.runner.running(session)) throw new BrowserctlError('conflict', 'a task run drives this session; browser tools wait until it ends');
      const result = await worker.call(name, args);
      this.#options.sessions.touch(session);
      return result;
    }).catch(refusal);
  }

  #bound(connection: Connection): { session: Session; worker: PlaywrightWorker } {
    if (!connection.session || !connection.worker) throw new BrowserctlError('invalid_request', 'no session is bound; call session_open first');
    return { session: connection.session, worker: connection.worker };
  }

  async #sessionTool(connection: Connection, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const { sessions, profiles, tasks, runner, audit, path } = this.#options;
    switch (name) {
      case 'profiles_list':
        return text((await profiles.list()).map((profile) => ({ name: profile.name, current_revision: profile.current, services: profile.services.map((service) => service.name) })));
      case 'session_open':
        return text(this.#describe(await this.#open(connection, sourceOf(args))));
      case 'session_close': {
        const { session } = this.#bound(connection);
        await sessions.close(session, 'closed');
        return text({ closed: session.id });
      }
      case 'session_status':
        return text(connection.session ? this.#describe(connection.session) : { bound: false });
      case 'session_file_put': {
        const { session } = this.#bound(connection);
        const written = await putFile(session, args.name, args.content_base64, path);
        await audit.record(connection.client, 'session.file_put', session.id, { path: written.path, bytes: written.bytes });
        return text(written);
      }
      case 'session_file_get': {
        const { session } = this.#bound(connection);
        const file = await getFile(session, args.name, path);
        await audit.record(connection.client, 'session.file_get', session.id, { path: file.path, bytes: file.content.length });
        return text({ path: file.path, bytes: file.content.length, content_base64: file.content.toString('base64') });
      }
      case 'task_list':
        return text((await tasks.list()).map((task) => ({ name: task.name, latest_revision: task.revisions.at(-1)?.id, revisions: task.revisions.length })));
      case 'task_get': {
        const { revision, content } = await tasks.read(String(args.name), optionalRevision(args.revision));
        return text({ name: args.name, revision: revision.id, created_at: revision.createdAt, client: revision.client, sha256: revision.sha256, content });
      }
      case 'task_save': {
        const revision = await tasks.save(String(args.name), args.content, connection.client);
        await audit.record(connection.client, 'task.save', String(args.name), { revision: revision.id, sha256: revision.sha256 });
        return text({ name: args.name, revision: revision.id, sha256: revision.sha256 });
      }
      case 'task_run': {
        const { session } = this.#bound(connection);
        const result = await runner.run(session, connection.client, String(args.name), optionalRevision(args.revision), args.input ?? {});
        return text({
          run: result.run,
          task: result.task,
          revision: result.revision,
          status: result.status,
          output: result.output ?? null,
          failure: result.failure ?? null,
          ...(result.errorClass && { error_class: result.errorClass }),
          duration_ms: result.durationMs,
        });
      }
      default:
        throw new BrowserctlError('not_found', `unknown tool ${name}`);
    }
  }

  async #open(connection: Connection, source: Source): Promise<Session> {
    if (connection.session || connection.opening) throw new BrowserctlError('conflict', 'a session is already bound; call session_close first');
    connection.opening = true;
    const { sessions } = this.#options;
    try {
      const session = await sessions.open(connection.client, source, 'agent');
      let worker: PlaywrightWorker;
      try {
        worker = await PlaywrightWorker.start({
          uid: session.users.sessionUid,
          gid: session.users.gid,
          home: session.workspace.sessionHome,
          path: this.#options.path,
          config: { endpoint: sessions.endpoint(session), outputDir: session.workspace.files, downloadsDir: session.workspace.downloads },
        });
      } catch (error) {
        await sessions.close(session, 'failed');
        throw error;
      }
      // The worker stops before the browser does when the session closes, whatever closes it; a worker that dies
      // first takes the session with it, so the agent never stays bound to a session without browser tools.
      session.closers.push(() => worker.stop());
      void worker.exited.then(() => {
        if (session.state === 'ready') void sessions.close(session, 'failed');
      });
      if (session.state !== 'ready' || !this.#connections.has(connection.id)) {
        await sessions.close(session, 'closed');
        throw new BrowserctlError('browser_failed', 'the session closed while it opened');
      }
      connection.session = session;
      connection.worker = worker;
      return session;
    } finally {
      connection.opening = false;
    }
  }

  #describe(session: Session): Record<string, unknown> {
    return {
      bound: true,
      id: session.id,
      source: sourceLabel(session),
      ...(session.source.kind === 'profile' && { profile: session.source.profile, revision: session.revision }),
      ...(session.source.kind === 'provider' && { provider: session.source.provider }),
      created_at: new Date(session.createdAt).toISOString(),
      file_area: { uploads: 'uploads/', downloads_and_outputs: './' },
    };
  }

  #unbind(connection: Connection): void {
    connection.session = undefined;
    connection.worker = undefined;
  }

  async #drop(connection: Connection): Promise<void> {
    if (!this.#connections.delete(connection.id)) return;
    const { session } = connection;
    this.#unbind(connection);
    if (session) await this.#options.sessions.close(session, 'closed');
    await connection.transport.close().catch(() => undefined);
    await connection.server.close().catch(() => undefined);
  }
}
