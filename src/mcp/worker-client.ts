// The server's side of a session's Playwright MCP worker: it starts the worker as the session user and talks MCP
// to it over the worker's stdin and stdout.

import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { BrowserctlError } from '../errors.ts';
import type { WorkerConfig } from '../worker/playwright.ts';

const WORKER = new URL('../worker/playwright.ts', import.meta.url).pathname;
const START_TIMEOUT_MS = 60_000;
/** Playwright actions wait for pages; a call may take this long before the server gives up on it. */
const CALL_TIMEOUT_MS = 5 * 60_000;

export interface WorkerOptions {
  uid: number;
  gid: number;
  home: string;
  path: string;
  config: WorkerConfig;
}

class ChildTransport implements Transport {
  readonly #child: ChildProcess;
  readonly #buffer = new ReadBuffer();
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(child: ChildProcess) {
    this.#child = child;
  }

  async start(): Promise<void> {
    this.#child.stdout!.on('data', (chunk: Buffer) => {
      this.#buffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = this.#buffer.readMessage();
        } catch (error) {
          this.onerror?.(error as Error);
          continue;
        }
        if (message === null) break;
        this.onmessage?.(message);
      }
    });
    this.#child.once('close', () => this.onclose?.());
    this.#child.stdin!.on('error', (error) => this.onerror?.(error));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.#child.stdin!.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.#child.stdin!.end();
  }
}

export class PlaywrightWorker {
  readonly #child: ChildProcess;
  readonly #client: Client;
  readonly exited: Promise<void>;

  private constructor(child: ChildProcess, client: Client) {
    this.#child = child;
    this.#client = client;
    this.exited = new Promise((resolve) => child.once('close', () => resolve()));
  }

  static async start(options: WorkerOptions): Promise<PlaywrightWorker> {
    const child = spawn(process.execPath, [WORKER], {
      uid: options.uid,
      gid: options.gid,
      cwd: options.config.outputDir,
      env: { HOME: options.home, TMPDIR: options.home, PATH: options.path, LANG: 'C.UTF-8' },
      stdio: ['pipe', 'pipe', 'ignore', 'pipe'],
    });
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    try {
      await spawned;
    } catch (error) {
      throw new BrowserctlError('browser_failed', 'cannot start the Playwright worker', { cause: error });
    }
    (child.stdio[3] as NodeJS.WritableStream).end(JSON.stringify(options.config));
    const client = new Client({ name: 'browserctl', version: '0' });
    const worker = new PlaywrightWorker(child, client);
    try {
      await client.connect(new ChildTransport(child), { timeout: START_TIMEOUT_MS });
    } catch (error) {
      worker.kill();
      throw new BrowserctlError('browser_failed', 'the Playwright worker did not start', { cause: error });
    }
    return worker;
  }

  async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      return (await this.#client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })) as CallToolResult;
    } catch (error) {
      throw new BrowserctlError('browser_failed', `${name} failed in the Playwright worker`, { cause: error });
    }
  }

  kill(): void {
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill('SIGKILL');
  }

  async stop(): Promise<void> {
    await this.#client.close().catch(() => undefined);
    this.kill();
    await this.exited;
  }
}
