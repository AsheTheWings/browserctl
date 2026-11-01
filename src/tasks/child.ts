// A task run's child process: it runs as the session user in the run directory, executes the task through e2e
// run() with the run directory's e2e.config.mjs, and writes a summary of the result to fd 3.

import { writeSync } from 'node:fs';
import { run } from 'e2e/runner';

const MAX_FAILURES = 10;
const MAX_FAILURE_CHARS = 500;

/** Every error the report holds, in order, from its run, results, attempts, and steps: messages and codes. */
function errors(report: unknown): { failures: string[]; codes: string[] } {
  const failures = new Set<string>();
  const codes = new Set<string>();
  const visit = (value: unknown, key: string) => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach((entry) => visit(entry, key));
    const record = value as Record<string, unknown>;
    if (key === 'error' || key === 'errors' || key === 'secondaryErrors') {
      if (typeof record.message === 'string' && failures.size < MAX_FAILURES) failures.add(record.message.slice(0, MAX_FAILURE_CHARS));
      if (typeof record.code === 'string') codes.add(record.code);
    }
    for (const [name, entry] of Object.entries(record)) visit(entry, name);
  };
  visit(report, '');
  return { failures: [...failures], codes: [...codes] };
}

let summary: { status: string; failures: string[]; codes: string[] };
try {
  const result = await run({ cwd: process.cwd(), config: './e2e.config.mjs' });
  summary = { status: result.status, ...(result.status === 'passed' ? { failures: [], codes: [] } : errors(result.report)) };
} catch (error) {
  summary = { status: 'error', failures: [String((error as Error).message ?? error).slice(0, MAX_FAILURE_CHARS)], codes: [] };
}
writeSync(3, JSON.stringify(summary));
process.exit(0);
