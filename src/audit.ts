// The audit log: one JSONL record per session, profile, task, and token action, with its client and time.

import { join } from 'node:path';
import { appendJsonl, readJsonl } from './state/files.ts';

export interface AuditRecord {
  time: string;
  client: string;
  action: string;
  subject?: string;
  detail?: Record<string, string | number | boolean>;
}

export class AuditLog {
  readonly #path: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(stateDirectory: string) {
    this.#path = join(stateDirectory, 'audit.jsonl');
  }

  /** Append a record; appends are serialized so lines never interleave. */
  record(client: string, action: string, subject?: string, detail?: AuditRecord['detail']): Promise<void> {
    const entry: AuditRecord = { time: new Date().toISOString(), client, action, ...(subject !== undefined && { subject }), ...(detail && { detail }) };
    const next = this.#tail.then(() => appendJsonl(this.#path, entry));
    this.#tail = next.catch(() => undefined);
    return next;
  }

  read(): Promise<AuditRecord[]> {
    return readJsonl<AuditRecord>(this.#path);
  }
}
