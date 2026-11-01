// Task runs: a task revision executed through e2e run() in a child process as the session's user, against the
// bound session's browser through its capability URL, with model calls through the forwarder and one replay cache
// per task. Every file in the run directory is written and read as the session user, never by the server's root.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, posix } from 'node:path';
import type { AuditLog } from '../audit.ts';
import { BrowserctlError } from '../errors.ts';
import { runAs } from '../sessions/run-as.ts';
import type { Session, SessionManager } from '../sessions/manager.ts';
import { emitEvent, inSpan, instrument } from '../telemetry/signals.ts';
import type { ModelForwarder } from './forwarder.ts';
import type { CacheFile, TaskStore } from './store.ts';

const APP_ROOT = new URL('../../', import.meta.url).pathname;
const CHILD = new URL('./child.ts', import.meta.url).pathname;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_CACHE_FILES = 2000;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_LOG_BYTES = 256 * 1024;
/** The base e2e resolves relative app.open paths against; tasks open pages by absolute URL. */
const APP_URL = 'http://127.0.0.1/';

export type RunStatus = 'passed' | 'failed' | 'timed_out' | 'error';

/** e2e error codes for a model that did not answer, which say nothing about the task or the site. */
const MODEL_CODES = new Set(['MODEL_UNAVAILABLE', 'MODEL_PROVIDER_FAILED']);

export interface TaskRunResult {
  run: string;
  task: string;
  revision: string;
  status: RunStatus;
  /** The JSON the task wrote to its output file, if any. */
  output: unknown;
  /** Why the run did not pass. */
  failure: string | undefined;
  /** The error class of a run that did not pass. */
  errorClass: 'task_failed' | 'timeout' | 'model_unavailable' | 'internal' | undefined;
  durationMs: number;
  /** The child's own output, for diagnosis by the server's operator and tests; never sent to a client. */
  log: string;
}

export interface TaskRunnerOptions {
  tasks: TaskStore;
  sessions: SessionManager;
  forwarder: ModelForwarder;
  audit: AuditLog;
  path: string;
  timeoutSeconds: number;
  /** The HTTP base task runs reach the server on, for the forwarder. */
  internalBase: () => string;
}

export class TaskRunner {
  readonly #options: TaskRunnerOptions;
  readonly #running = new Set<Session>();

  constructor(options: TaskRunnerOptions) {
    this.#options = options;
  }

  /** Whether a task run drives the session now, which keeps other tools off its browser. */
  running(session: Session): boolean {
    return this.#running.has(session);
  }

  run(session: Session, client: string, name: string, revision?: string, input: unknown = {}): Promise<TaskRunResult> {
    if (this.#running.has(session)) return Promise.reject(new BrowserctlError('conflict', 'a task run already drives this session'));
    if (session.state !== 'ready') return Promise.reject(new BrowserctlError('invalid_request', 'the session is not open'));
    const encoded = JSON.stringify(input ?? {});
    if (Buffer.byteLength(encoded) > MAX_INPUT_BYTES) return Promise.reject(new BrowserctlError('invalid_request', `task input is at most ${MAX_INPUT_BYTES} bytes`));
    this.#running.add(session);
    return inSpan('browserctl.task.run', { 'browserctl.session.id': session.id }, async (span) => {
      const started = performance.now();
      try {
        const { revision: entry, content } = await this.#options.tasks.read(name, revision);
        const result = await this.#execute(session, name, entry.id, content, encoded);
        span.setAttribute('browserctl.task.run_status', result.status);
        if (result.errorClass) span.setAttribute('error.type', result.errorClass);
        const durationMs = Math.round(performance.now() - started);
        instrument().taskRunDuration.record(durationMs / 1000, { 'browserctl.task.run_status': result.status });
        if (result.errorClass) {
          emitEvent('browserctl.task.run.failed', {
            'browserctl.session.id': session.id,
            'browserctl.task': name,
            'browserctl.task.run_status': result.status,
            'error.type': result.errorClass,
          });
        }
        await this.#options.audit.record(client, 'task.run', name, { revision: entry.id, run: result.run, session: session.id, status: result.status });
        return { ...result, task: name, revision: entry.id, durationMs };
      } finally {
        this.#running.delete(session);
      }
    });
  }

  async #execute(session: Session, name: string, revision: string, content: string, input: string): Promise<Omit<TaskRunResult, 'task' | 'revision' | 'durationMs'>> {
    const { sessions, forwarder, tasks } = this.#options;
    const run = `r-${randomBytes(9).toString('base64url')}`;
    const home = session.workspace.sessionHome;
    const directory = join(home, 'runs', run);
    const as = (cwd: string) => ({ uid: session.users.sessionUid, gid: session.users.gid, cwd, path: this.#options.path });
    const write = async (relative: string, data: string | Buffer) => {
      const result = await runAs(['sh', '-c', 'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', relative], { ...as(directory), input: Buffer.from(data) });
      if (result.status !== 0) throw new BrowserctlError('internal', 'cannot prepare the task run');
    };
    const browser = sessions.runEndpoint(session);
    const credential = forwarder.issue();
    try {
      if ((await runAs(['mkdir', '-p', '-m', '700', posix.join('runs', run, 'cache')], as(home))).status !== 0) {
        throw new BrowserctlError('internal', 'cannot prepare the task run');
      }
      if ((await runAs(['ln', '-s', join(APP_ROOT, 'node_modules'), 'node_modules'], as(directory))).status !== 0) {
        throw new BrowserctlError('internal', 'cannot prepare the task run');
      }
      await write('task.e2e.ts', content);
      await write('input.json', input);
      for (const file of await tasks.cache(name)) await write(posix.join('cache', file.path), file.content);
      await write('e2e.config.mjs', configModule({
        session: session.id,
        endpoint: browser.endpoint,
        cacheDir: join(directory, 'cache'),
        appUrl: APP_URL,
        // e2e's own deadline falls after the server's, so the server's timeout always decides.
        timeoutMs: (this.#options.timeoutSeconds + 60) * 1000,
        model: forwarder.modelName ? { baseUrl: `${this.#options.internalBase()}/v1`, name: forwarder.modelName, token: credential.token } : undefined,
      }));

      const outcome = await this.#spawn(session, directory);
      const output = await this.#readOutput(session, directory);
      // Only a run that ended on its own, in a session still open, wrote a whole cache; a killed or cut-off run's
      // cache may be partial, and e2e itself leaves the cache unchanged when a run is cancelled.
      if (outcome.finished && session.state === 'ready') await tasks.replaceCache(name, await this.#readCache(session, directory));
      let status = outcome.status;
      if (status === 'failed' && outcome.codes.some((code) => MODEL_CODES.has(code))) status = 'error';
      if (status === 'passed' && output.problem) status = 'failed';
      const errorClass = status === 'passed' ? undefined
        : status === 'timed_out' ? 'timeout'
        : outcome.codes.some((code) => MODEL_CODES.has(code)) ? 'model_unavailable'
        : status === 'failed' ? 'task_failed'
        : 'internal';
      return { run, status, output: output.value, failure: outcome.failure ?? output.problem, errorClass, log: outcome.log };
    } finally {
      credential.revoke();
      browser.release();
      await runAs(['rm', '-rf', '--', posix.join('runs', run)], as(home)).catch(() => undefined);
    }
  }

  #spawn(session: Session, directory: string): Promise<{ status: RunStatus; failure: string | undefined; codes: string[]; finished: boolean; log: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CHILD], {
        uid: session.users.sessionUid,
        gid: session.users.gid,
        cwd: directory,
        detached: true,
        env: {
          HOME: session.workspace.sessionHome,
          TMPDIR: session.workspace.sessionHome,
          PATH: this.#options.path,
          LANG: 'C.UTF-8',
          E2E_TELEMETRY_DISABLED: '1',
          DO_NOT_TRACK: '1',
          BROWSERCTL_TASK_INPUT_FILE: join(directory, 'input.json'),
          BROWSERCTL_TASK_OUTPUT_FILE: join(directory, 'output.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      });
      let log = '';
      const keep = (chunk: Buffer) => {
        if (log.length < MAX_LOG_BYTES) log += chunk.toString('utf8').slice(0, MAX_LOG_BYTES - log.length);
      };
      child.stdout!.on('data', keep);
      child.stderr!.on('data', keep);
      let summary = '';
      (child.stdio[3] as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
        if (summary.length < MAX_LOG_BYTES) summary += chunk.toString('utf8');
      });
      let timedOut = false;
      const killGroup = () => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // The group is gone.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, this.#options.timeoutSeconds * 1000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(new BrowserctlError('internal', 'cannot start the task run', { cause: error }));
      });
      child.once('close', () => {
        clearTimeout(timer);
        // Nothing the task started outlives its run.
        killGroup();
        if (timedOut) return resolve({ status: 'timed_out', failure: `the run exceeded ${this.#options.timeoutSeconds} seconds`, codes: [], finished: false, log });
        try {
          const parsed = JSON.parse(summary) as { status: string; failures: string[]; codes: string[] };
          const status: RunStatus = parsed.status === 'passed' ? 'passed' : parsed.status === 'failed' ? 'failed' : 'error';
          resolve({ status, failure: parsed.failures.length > 0 ? parsed.failures.join('\n') : undefined, codes: parsed.codes, finished: true, log });
        } catch {
          resolve({ status: 'error', failure: 'the run ended without a result', codes: [], finished: false, log });
        }
      });
    });
  }

  async #readOutput(session: Session, directory: string): Promise<{ value: unknown; problem: string | undefined }> {
    const result = await runAs(['sh', '-c', 'test -f output.json && exec cat output.json'], {
      uid: session.users.sessionUid, gid: session.users.gid, cwd: directory, path: this.#options.path, maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    if (result.overflowed) return { value: undefined, problem: `the task output is over ${MAX_OUTPUT_BYTES} bytes` };
    if (result.status !== 0) return { value: undefined, problem: undefined };
    try {
      return { value: JSON.parse(result.output.toString('utf8')), problem: undefined };
    } catch {
      return { value: undefined, problem: 'the task output is not JSON' };
    }
  }

  /** The run's cache files, read as the session user: only regular files, within the file and size bounds. */
  async #readCache(session: Session, directory: string): Promise<CacheFile[]> {
    const as = { uid: session.users.sessionUid, gid: session.users.gid, cwd: join(directory, 'cache'), path: this.#options.path };
    const listed = await runAs(['find', '.', '-type', 'f', '-print0'], { ...as, maxOutputBytes: 1024 * 1024 });
    if (listed.status !== 0 || listed.overflowed) return [];
    const files: CacheFile[] = [];
    let total = 0;
    for (const raw of listed.output.toString('utf8').split('\0').filter(Boolean).slice(0, MAX_CACHE_FILES)) {
      const path = posix.normalize(raw);
      if (path.startsWith('..') || posix.isAbsolute(path)) continue;
      const read = await runAs(['cat', '--', path], { ...as, maxOutputBytes: MAX_CACHE_BYTES - total });
      if (read.status !== 0 || read.overflowed) continue;
      total += read.output.length;
      files.push({ path, content: read.output });
    }
    return files;
  }
}

interface ConfigSettings {
  session: string;
  endpoint: string;
  cacheDir: string;
  appUrl: string;
  timeoutMs: number;
  model: { baseUrl: string; name: string; token: string } | undefined;
}

/** The run's e2e config: the bound session's browser, left open after the run, and the forwarder as the model. */
function configModule(settings: ConfigSettings): string {
  return `// Written by browserctl for one task run.
import { web } from '@e2e-dev/web';
import { createOpenAI } from '@ai-sdk/openai';

const settings = ${JSON.stringify(settings)};
const browser = {
  name: 'browserctl',
  scope: 'attempt',
  async acquire() {
    return { id: settings.session, cdpEndpoint: settings.endpoint };
  },
  async release() {},
};

export default {
  projectId: 'browserctl-task',
  targets: [{ name: 'session', engine: web({ browser }), app: { url: settings.appUrl } }],
  ...(settings.model && {
    agents: { default: { model: createOpenAI({ baseURL: settings.model.baseUrl, apiKey: settings.model.token }).responses(settings.model.name) } },
  }),
  cache: { mode: 'read-write', dir: settings.cacheDir },
  tests: ['task.e2e.ts'],
  workers: 1,
  retries: 0,
  timeout: settings.timeoutMs,
  trace: 'off',
  video: 'off',
};
`;
}

