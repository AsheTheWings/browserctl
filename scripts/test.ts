// Run one test class, or a gate, each class in a child process with an explicit input allowlist.
//
//   node scripts/test.ts fast|release|unit|component|conformance|integration
//
// A class receives only PATH, LANG, and a run-owned HOME and TMPDIR, so no developer or host input reaches it.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const CLASSES = ['unit', 'component', 'conformance', 'integration'] as const;
const GATES: Record<string, readonly string[]> = {
  fast: ['typecheck', 'unit', 'component', 'conformance'],
  release: ['typecheck', 'unit', 'component', 'conformance', 'integration'],
};

function usage(): number {
  process.stderr.write('usage: node scripts/test.ts fast|release|unit|component|conformance|integration\n');
  return 2;
}

function run(step: string): number {
  const home = mkdtempSync(join(tmpdir(), `browserctl-test-${step}-`));
  const environment: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: home, TMPDIR: home };
  try {
    let argv: string[];
    if (step === 'typecheck') argv = [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', join(ROOT, 'tsconfig.json')];
    else {
      const directory = join(ROOT, 'test', step);
      if (!existsSync(directory)) return 0;
      const files = readdirSync(directory).filter((name) => name.endsWith('.test.ts')).map((name) => join(directory, name));
      if (files.length === 0) return 0;
      argv = ['--test', '--test-reporter=spec', ...(step === 'integration' ? ['--test-concurrency=1'] : []), ...files];
    }
    const result = spawnSync(process.execPath, argv, { cwd: ROOT, env: environment, stdio: 'inherit' });
    if (result.status !== 0) {
      process.stderr.write(`FAILED class=${step}; reproduce: node scripts/test.ts ${step}\n`);
      return result.status ?? 1;
    }
    return 0;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function main(argv: string[]): number {
  const [selected, ...rest] = argv;
  if (!selected || rest.length > 0) return usage();
  const steps = GATES[selected] ?? ((CLASSES as readonly string[]).includes(selected) ? [selected] : undefined);
  if (!steps) return usage();
  for (const step of steps) {
    const status = run(step);
    if (status !== 0) return status;
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
