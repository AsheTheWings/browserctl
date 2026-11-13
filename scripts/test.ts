// Run one test class, or a gate, each class in a child process with an explicit input allowlist.
//
//   node scripts/test.ts fast|release|unit|component|conformance|integration|qualification
//
// A class receives only PATH, LANG, and a run-owned HOME and TMPDIR, so no developer or host input reaches it.
// Integration tests run inside the image's test stage under rootless Podman, as container root with the server's
// capability set; Podman itself receives only PATH, HOME, and XDG_RUNTIME_DIR. Qualification runs the built image
// under rootless Podman and additionally receives the image layout and revision it names.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTAINER_CAPABILITIES } from './container.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const CLASSES = ['unit', 'component', 'conformance', 'integration', 'qualification'] as const;
const GATES: Record<string, readonly string[]> = {
  fast: ['typecheck', 'unit', 'component', 'conformance'],
  release: ['typecheck', 'unit', 'component', 'conformance', 'qualification'],
};
/** Set inside the test container, where the integration class runs directly. */
const IN_IMAGE = 'TEST_IN_IMAGE';

function usage(): number {
  process.stderr.write('usage: node scripts/test.ts fast|release|unit|component|conformance|integration|qualification\n');
  return 2;
}

function failed(step: string, status: number | null): number {
  process.stderr.write(`FAILED class=${step}; reproduce: node scripts/test.ts ${step}\n`);
  return status ?? 1;
}

function podman(args: string[]): number | null {
  const environment: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  for (const name of ['HOME', 'XDG_RUNTIME_DIR']) if (process.env[name]) environment[name] = process.env[name]!;
  return spawnSync('podman', args, { cwd: ROOT, env: environment, stdio: 'inherit' }).status;
}

/** Build the test stage under a run-owned tag, run the integration class in it, and remove the tag. */
function integrationInImage(): number {
  const tag = `localhost/browserctl-test:run-${randomBytes(6).toString('hex')}`;
  try {
    const built = podman(['build', '--quiet', '--target', 'test', '--tag', tag, '--file', 'Containerfile', '.']);
    if (built !== 0) return failed('integration', built);
    const ran = podman([
      'run', '--rm', '--network=none', '--cap-drop=all', ...CONTAINER_CAPABILITIES.map((capability) => `--cap-add=${capability}`),
      '--security-opt=no-new-privileges', `--env=${IN_IMAGE}=1`, tag, 'node', 'scripts/test.ts', 'integration',
    ]);
    // The run inside the image reports its own failure.
    return ran ?? 1;
  } finally {
    podman(['rmi', '--force', '--ignore', tag]);
  }
}

function run(step: string): number {
  if (step === 'integration' && !process.env[IN_IMAGE]) return integrationInImage();
  const home = mkdtempSync(join(tmpdir(), 'bt-'));
  // Session users pass through it to reach session directories under it.
  chmodSync(home, 0o711);
  const environment: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: home, TMPDIR: home };
  if (step === 'qualification') {
    for (const name of ['BROWSERCTL_QUALIFICATION_LAYOUT', 'BROWSERCTL_QUALIFICATION_REVISION', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME']) {
      if (process.env[name]) environment[name] = process.env[name]!;
    }
    // The built image is not unpacked into a run-owned home: Podman's store stays the operator's own.
    if (process.env.HOME) environment.BROWSERCTL_QUALIFICATION_HOME = process.env.HOME;
    if (process.env.XDG_DATA_HOME) environment.BROWSERCTL_QUALIFICATION_DATA_HOME = process.env.XDG_DATA_HOME;
  }
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
    return result.status === 0 ? 0 : failed(step, result.status);
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
