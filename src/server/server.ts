// The server's composition: state, authentication, the admin socket, and the HTTP listener.

import { chmod, mkdir } from 'node:fs/promises';
import { AdminServer } from '../admin/socket.ts';
import { AuditLog } from '../audit.ts';
import { TokenStore } from '../auth/tokens.ts';
import { verifyProtectedFiles, type ServerConfig } from '../config/config.ts';
import { BrowserctlError } from '../errors.ts';
import { HttpRouter, sendJson } from './http.ts';

const ADMIN_CLIENT = 'admin';

/** Run one startup step; a system failure becomes a message naming the step and its error code. */
async function step<T>(description: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BrowserctlError) throw error;
    const code = (error as NodeJS.ErrnoException).code ?? 'error';
    throw new BrowserctlError('internal', `cannot ${description} (${code})`, { cause: error });
  }
}

export class BrowserctlServer {
  readonly config: ServerConfig;
  readonly tokens: TokenStore;
  readonly audit: AuditLog;
  readonly admin = new AdminServer();
  readonly http = new HttpRouter();
  port = 0;

  constructor(config: ServerConfig) {
    this.config = config;
    this.tokens = new TokenStore(config.stateDirectory);
    this.audit = new AuditLog(config.stateDirectory);
  }

  async start(): Promise<void> {
    const { config } = this;
    verifyProtectedFiles(config);
    await step('create the state directory', async () => {
      await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
      await chmod(config.stateDirectory, 0o700);
    });
    await step('create the session work directory', () => mkdir(config.workDirectory, { recursive: true, mode: 0o711 }));
    await step('create the recordings directory', () => mkdir(config.recordingsDirectory, { recursive: true, mode: 0o700 }));
    await this.tokens.load();
    this.#adminCommands();
    this.http.route('/healthz', (_request, response) => sendJson(response, 200, { status: 'ok' }));
    await step('open the admin socket', () => this.admin.listen(config.stateDirectory));
    this.port = await step(`listen on ${config.listenAddress}:${config.port}`, () => this.http.listen(config.listenAddress, config.port));
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
    this.admin.handle('tokens.revoke', async (args) => {
      const client = name(args);
      await this.tokens.revoke(client);
      await this.audit.record(ADMIN_CLIENT, 'token.revoke', client);
      return { name: client };
    });
  }

  async stop(): Promise<void> {
    await this.admin.close();
    await this.http.close();
  }
}
