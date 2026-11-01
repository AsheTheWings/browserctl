import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadAdminConfig, loadServerConfig } from '../../src/config/config.ts';
import { ConfigError, check, parseLines, parseProviders, resolve, type LayerFile } from '../../src/config/schema.ts';

const HOME = { HOME: '/home/someone' };
const files = (entries: Record<string, LayerFile>) => (path: string) => entries[path];
const none = () => undefined;

function problems(work: () => unknown): string[] {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof ConfigError, String(error));
    return error.problems;
  }
  assert.fail('expected a ConfigError');
}

describe('server configuration defaults', () => {
  it('defaults directories under XDG and the state directory', () => {
    const config = loadServerConfig(HOME, none);
    assert.equal(config.stateDirectory, '/home/someone/.local/state/browserctl');
    assert.equal(config.workDirectory, '/home/someone/.cache/browserctl');
    assert.equal(config.recordingsDirectory, '/home/someone/.local/state/browserctl/recordings');
  });

  it('follows XDG variables and treats empty ones as unset', () => {
    const config = loadServerConfig({ ...HOME, XDG_STATE_HOME: '/state', XDG_CACHE_HOME: '' }, none);
    assert.equal(config.stateDirectory, '/state/browserctl');
    assert.equal(config.recordingsDirectory, '/state/browserctl/recordings');
    assert.equal(config.workDirectory, '/home/someone/.cache/browserctl');
  });

  it('refuses a work directory too long for Chrome\'s singleton socket', () => {
    const work = `/${'w'.repeat(42)}`;
    assert.equal(loadServerConfig({ ...HOME, BROWSERCTL_WORK_DIRECTORY: work }, none).workDirectory, work);
    assert.deepEqual(problems(() => loadServerConfig({ ...HOME, BROWSERCTL_WORK_DIRECTORY: `${work}w` }, none)), [
      'BROWSERCTL_WORK_DIRECTORY: 44 bytes long; Chrome needs at most 43',
    ]);
  });

  it('defaults to loopback and the settled limits', () => {
    for (const profile of ['development', 'production']) {
      const environment =
        profile === 'production'
          ? { ...HOME, BROWSERCTL_PROFILE: profile, BROWSERCTL_PORT: '9000', BROWSERCTL_PUBLIC_BASE_URL: 'http://127.0.0.1:9000',
              BROWSERCTL_MODEL_BASE_URL: 'http://127.0.0.1:1/v1', BROWSERCTL_MODEL_NAME: 'm', BROWSERCTL_MODEL_KEY_FILE: '/run/key',
              BROWSERCTL_DEPLOYMENT_ENVIRONMENT: 'production', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' }
          : HOME;
      const config = loadServerConfig(environment, none);
      assert.equal(config.listenAddress, '127.0.0.1');
      assert.equal(config.sessionLimit, 4);
      assert.equal(config.idleSeconds, 30 * 60);
      assert.equal(config.lifetimeSeconds, 4 * 60 * 60);
      assert.equal(config.taskTimeoutSeconds, 10 * 60);
      assert.equal(config.serviceCheckIntervalSeconds, 12 * 60 * 60);
      assert.equal(config.recordingsCapBytes, 40 * 1024 ** 3);
      assert.deepEqual([config.telemetry.traces, config.telemetry.metrics, config.telemetry.logs], ['otlp', 'otlp', 'otlp']);
    }
  });

  it('requires the model, port, public URL, endpoint, and environment name in production', () => {
    const found = problems(() => loadServerConfig({ ...HOME, BROWSERCTL_PROFILE: 'production' }, none));
    for (const name of ['BROWSERCTL_MODEL_BASE_URL', 'BROWSERCTL_MODEL_NAME', 'BROWSERCTL_MODEL_KEY_FILE', 'BROWSERCTL_PORT',
      'BROWSERCTL_PUBLIC_BASE_URL', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'BROWSERCTL_DEPLOYMENT_ENVIRONMENT']) {
      assert.ok(found.includes(`${name}: required in the production profile`), name);
    }
  });

  it('leaves the model unset in development and refuses a partial model', () => {
    assert.equal(loadServerConfig(HOME, none).model, undefined);
    const found = problems(() => loadServerConfig({ ...HOME, BROWSERCTL_MODEL_NAME: 'm' }, none));
    assert.match(found[0]!, /set all three or none/);
  });

  it('requires HOME only when a default refers to it', () => {
    assert.ok(problems(() => loadServerConfig({}, none)).includes('HOME: required in the development profile'));
    const config = loadAdminConfig({ BROWSERCTL_STATE_DIRECTORY: '/s' }, none);
    assert.equal(config.stateDirectory, '/s');
  });
});

describe('layers', () => {
  it('applies defaults, overlays in order, the protected file, then process inputs', () => {
    const read = files({
      '/o1': { text: 'BROWSERCTL_PORT=9001\nBROWSERCTL_SESSION_LIMIT=2\n', ownerOnly: false },
      '/o2': { text: '# comment\n\nBROWSERCTL_PORT=9002\n', ownerOnly: false },
      '/p': { text: 'BROWSERCTL_MODEL_KEY_FILE=/run/key\n', ownerOnly: true },
    });
    const { values } = resolve('server', { ...HOME, BROWSERCTL_OVERLAY_FILES: '/o1:/missing:/o2', BROWSERCTL_PROTECTED_FILE: '/p',
      BROWSERCTL_SESSION_LIMIT: '3' }, read);
    assert.equal(values.get('BROWSERCTL_PORT'), '9002');
    assert.equal(values.get('BROWSERCTL_SESSION_LIMIT'), '3');
    assert.equal(values.get('BROWSERCTL_MODEL_KEY_FILE'), '/run/key');
  });

  it('refuses protected inputs in overlays and configuration in the protected file', () => {
    const read = files({
      '/o': { text: 'BROWSERCTL_MODEL_KEY_FILE=/run/key\n', ownerOnly: false },
      '/p': { text: 'BROWSERCTL_PORT=1\n', ownerOnly: true },
    });
    const found = problems(() => resolve('server', { ...HOME, BROWSERCTL_OVERLAY_FILES: '/o', BROWSERCTL_PROTECTED_FILE: '/p' }, read));
    assert.ok(found.some((problem) => problem.includes('BROWSERCTL_MODEL_KEY_FILE is protected')));
    assert.ok(found.some((problem) => problem.includes('BROWSERCTL_PORT is not protected')));
  });

  it('fails closed on a malformed, unreadable, or unprotected layer and on unknown names', () => {
    const read = (path: string): LayerFile | undefined => {
      if (path === '/bad') return { text: 'not a line\n', ownerOnly: false };
      if (path === '/unknown') return { text: 'BROWSERCTL_NOPE=1\n', ownerOnly: false };
      if (path === '/open') return { text: '', ownerOnly: false };
      if (path === '/twice') return { text: 'BROWSERCTL_PORT=1\nBROWSERCTL_PORT=2\n', ownerOnly: false };
      if (path === '/process') return { text: 'BROWSERCTL_PROFILE=production\n', ownerOnly: false };
      throw new Error('EACCES');
    };
    const found = problems(() =>
      resolve('server', { ...HOME, BROWSERCTL_OVERLAY_FILES: '/bad:/unknown:/locked:/twice:/process', BROWSERCTL_PROTECTED_FILE: '/open',
        OTEL_EXPORTER_OTLP_HEADERS: 'a=b' }, read),
    );
    assert.deepEqual(found.sort(), [
      '/bad:1: want NAME=value',
      '/locked: unreadable',
      '/open: a protected file must be readable by its owner alone',
      '/process: BROWSERCTL_PROFILE is only a process input',
      '/twice:2: BROWSERCTL_PORT is set twice',
      '/unknown: BROWSERCTL_NOPE is not an input of browserctl',
      'OTEL_EXPORTER_OTLP_HEADERS: not an input of browserctl',
    ]);
  });

  it('reports a shape problem without the value', () => {
    const found = problems(() => resolve('server', { ...HOME, BROWSERCTL_SESSION_LIMIT: 'secret-ish' }, none));
    assert.deepEqual(found, ['BROWSERCTL_SESSION_LIMIT: want a whole number']);
  });
});

describe('shapes', () => {
  it('checks each shape', () => {
    assert.equal(check({ type: 'integer', min: 1, max: 16 }, '16'), undefined);
    assert.ok(check({ type: 'integer', min: 1, max: 16 }, '17'));
    assert.ok(check({ type: 'integer', min: 1, max: 16 }, '01'));
    assert.equal(check({ type: 'ip' }, '::1'), undefined);
    assert.ok(check({ type: 'ip' }, 'localhost'));
    assert.ok(check({ type: 'port' }, '65536'));
    assert.ok(check({ type: 'path' }, 'relative'));
    assert.ok(check({ type: 'path' }, '/a/../b'));
    assert.equal(check({ type: 'path', empty: true }, ''), undefined);
    assert.ok(check({ type: 'url' }, 'http://user:pw@host/'));
    assert.ok(check({ type: 'url' }, 'ftp://host/'));
    assert.equal(check({ type: 'url' }, 'https://host:1/v1'), undefined);
  });

  it('parses NAME=value lines literally', () => {
    assert.deepEqual([...parseLines("A='x'\nB=a=b\n", 'f')], [['A', "'x'"], ['B', 'a=b']]);
  });
});

describe('external providers', () => {
  const entry = { name: 'example', leaseUrl: 'http://192.0.2.10:8000/', cdpHost: '192.0.2.10', tokenFile: '/run/token' };

  it('accepts a valid list', () => {
    assert.deepEqual(parseProviders(JSON.stringify([entry])), [{ ...entry, leaseUrl: 'http://192.0.2.10:8000' }]);
  });

  it('refuses malformed entries', () => {
    const cases: Array<[unknown, RegExp]> = [
      [{}, /JSON list/],
      [[{ ...entry, cdpHost: 'example.test' }], /cdpHost must be an IP address/],
      [[entry, entry], /appears twice/],
      [[{ ...entry, tokenFile: 'token' }], /tokenFile/],
      [[{ ...entry, extra: 1 }], /unknown key/],
      [[{ ...entry, leaseUrl: 'nope' }], /leaseUrl/],
      [[{ ...entry, name: 7 }], /name must be a string/],
    ];
    for (const [value, pattern] of cases) assert.throws(() => parseProviders(JSON.stringify(value)), pattern);
  });

  it('makes the server refuse to start on a malformed entry', () => {
    const found = problems(() => loadServerConfig({ ...HOME, BROWSERCTL_PROVIDERS: '[{"name":"x"}]' }, none));
    assert.match(found[0]!, /^BROWSERCTL_PROVIDERS: entry 0/);
  });
});
