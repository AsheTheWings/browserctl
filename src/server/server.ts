// The server's composition: state, authentication, the admin socket, and the HTTP listener.

import { chmod, mkdir } from 'node:fs/promises';
import { AdminServer } from '../admin/socket.ts';
import { AuditLog } from '../audit.ts';
import { TokenStore } from '../auth/tokens.ts';
import type { ServerConfig } from '../config/config.ts';
import { BrowserctlError } from '../errors.ts';
import { HttpRouter, sendJson } from './http.ts';

const ADMIN_CLIENT = 'admin';

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
    await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(config.stateDirectory, 0o700);
    await mkdir(config.workDirectory, { recursive: true, mode: 0o711 });
    await mkdir(config.recordingsDirectory, { recursive: true, mode: 0o700 });
    await this.tokens.load();
    this.#adminCommands();
    this.http.route('/healthz', (_request, response) => sendJson(response, 200, { status: 'ok' }));
    await this.admin.listen(config.stateDirectory);
    this.port = await this.http.listen(config.listenAddress, config.port);
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
