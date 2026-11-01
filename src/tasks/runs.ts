// Recent task runs, for the dashboard: the newest runs with their status, client, input, and output.
//
//   <state>/runs.jsonl   one record per run, oldest first, rewritten to the newest KEEP when it grows past twice that

import { join } from 'node:path';
import { Serializer, appendJsonl, readJsonl, writeAtomic } from '../state/files.ts';
import type { RunStatus } from './runner.ts';

export const KEEP = 200;
/** Inputs and outputs longer than this, as JSON, are kept as a truncated preview. */
export const MAX_VALUE_CHARS = 16 * 1024;

export interface RunRecord {
  run: string;
  task: string;
  revision: string;
  client: string;
  session: string;
  status: RunStatus;
  startedAt: string;
  durationMs: number;
  /** The input as JSON, cut at MAX_VALUE_CHARS. */
  input: string;
  /** The output as JSON, cut at MAX_VALUE_CHARS; absent when the run wrote none. */
  output: string | undefined;
  failure: string | undefined;
}

export function preview(value: unknown): string {
  const text = JSON.stringify(value ?? null);
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

export class RunLog {
  readonly #path: string;
  readonly #serializer = new Serializer();
  #records: RunRecord[] | undefined;
  #written = 0;

  constructor(stateDirectory: string) {
    this.#path = join(stateDirectory, 'runs.jsonl');
  }

  async #load(): Promise<RunRecord[]> {
    if (!this.#records) {
      const all = await readJsonl<RunRecord>(this.#path);
      this.#written = all.length;
      this.#records = all.slice(-KEEP);
    }
    return this.#records;
  }

  append(record: RunRecord): Promise<void> {
    return this.#serializer.run(async () => {
      const records = await this.#load();
      records.push(record);
      if (records.length > KEEP) records.splice(0, records.length - KEEP);
      if (this.#written + 1 > 2 * KEEP) {
        await writeAtomic(this.#path, records.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
        this.#written = records.length;
      } else {
        await appendJsonl(this.#path, record);
        this.#written += 1;
      }
    });
  }

  /** The newest runs, newest first. */
  async recent(): Promise<RunRecord[]> {
    return this.#serializer.run(async () => [...(await this.#load())].reverse());
  }
}
