import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderEnvFile, schema } from '../../src/config/schema.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('input schema', () => {
  it('matches the tracked .env', () => {
    assert.equal(read('.env'), renderEnvFile(), 'regenerate with: node scripts/env.ts > .env');
  });

  it('declares each input once with a known class, process, and profile', () => {
    const names = schema.inputs.map((input) => input.name);
    assert.equal(new Set(names).size, names.length);
    for (const input of schema.inputs) {
      assert.ok(['configuration', 'protected'].includes(input.class), input.name);
      assert.ok(input.processes.length > 0 && input.processes.every((process) => ['server', 'admin'].includes(process)), input.name);
      for (const profile of Object.keys(input.defaults)) assert.ok(schema.profiles.includes(profile as never), input.name);
      assert.ok(input.description.length > 0, input.name);
    }
  });

  it('gives the model inputs no production default', () => {
    for (const name of ['BROWSERCTL_MODEL_BASE_URL', 'BROWSERCTL_MODEL_NAME', 'BROWSERCTL_MODEL_KEY_FILE']) {
      assert.equal(schema.inputs.find((input) => input.name === name)?.defaults.production, undefined, name);
    }
    assert.equal(schema.inputs.find((input) => input.name === 'BROWSERCTL_MODEL_KEY_FILE')?.class, 'protected');
  });

  it('reads process inputs only through the schema loader', () => {
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (path.endsWith('.ts') && /process\.env\b/.test(read(path))) offenders.push(path);
      }
    };
    walk('src');
    assert.deepEqual(offenders, [], 'only bin/ passes process.env to the entry points');
  });
});

describe('test classes', () => {
  const UNIT_FORBIDDEN = /from 'node:(fs|fs\/promises|net|http|https|child_process|dgram|worker_threads)'/;

  it('keeps every test file in a class directory and unit tests pure', () => {
    const classes = ['unit', 'component', 'conformance', 'integration', 'support'];
    for (const entry of readdirSync(join(ROOT, 'test'), { withFileTypes: true })) {
      assert.ok(entry.isDirectory() && classes.includes(entry.name), `test/${entry.name} is not a test class`);
    }
    for (const name of readdirSync(join(ROOT, 'test', 'unit'))) {
      const text = read(join('test', 'unit', name));
      assert.doesNotMatch(text, UNIT_FORBIDDEN, `test/unit/${name} uses the filesystem, network, or processes`);
      assert.doesNotMatch(text, /support\/(server|telemetry)/, `test/unit/${name} uses component support`);
    }
  });
});

describe('provider neutrality', () => {
  // Providers are configuration: no source names an operating system or a network address beyond loopback and
  // the documentation ranges.
  const ADDRESS = /\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
  const SYSTEM = /\bwindows\b/i;

  it('keeps every source and doc free of a specific provider', () => {
    const offenders: string[] = [];
    const check = (path: string) => {
      const text = read(path);
      if (ADDRESS.test(text) || SYSTEM.test(text)) offenders.push(path);
    };
    const walk = (directory: string) => {
      for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else check(path);
      }
    };
    for (const directory of ['src', 'bin', 'scripts', 'config', 'docs']) walk(directory);
    for (const file of ['README.md', 'Containerfile']) check(file);
    assert.deepEqual(offenders, []);
  });
});
