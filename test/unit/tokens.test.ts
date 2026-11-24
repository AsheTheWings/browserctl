import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bearerToken, hashToken } from '../../src/auth/tokens.ts';
import { parseCapacity } from '../../src/providers/sources.ts';
import { parseHeaders, serviceVersion } from '../../src/telemetry/sdk.ts';

describe('token helpers', () => {
  it('hashes with SHA-256', () => {
    assert.equal(hashToken('abc').toString('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('takes only a well-formed bearer token', () => {
    assert.equal(bearerToken('Bearer bctl_abc-_9'), 'bctl_abc-_9');
    assert.equal(bearerToken('bearer x'), undefined);
    assert.equal(bearerToken('Bearer a b'), undefined);
    assert.equal(bearerToken(undefined), undefined);
  });
});

describe('OTLP headers', () => {
  it('parses percent-encoded pairs', () => {
    assert.deepEqual(parseHeaders('Authorization=Basic%20abc, X-Other=1'), { Authorization: 'Basic abc', 'X-Other': '1' });
  });

  it('refuses malformed pairs without echoing them', () => {
    assert.throws(() => parseHeaders('novalue'), /BROWSERCTL_OTLP_HEADERS_FILE: want key=value/);
    assert.throws(() => parseHeaders('bad name=1'), /header name/);
  });
});

describe('telemetry service.version', () => {
  it('appends build revision metadata when built from a commit', () => {
    assert.equal(serviceVersion({ version: '0.0.0', revision: 'abc123def' }), '0.0.0+abc123def');
    assert.equal(serviceVersion({ version: '1.2.3+abc123def', revision: 'abc123def' }), '1.2.3+abc123def');
    assert.equal(serviceVersion({ version: '0.0.0-source', revision: 'unknown' }), '0.0.0-source');
  });
});

describe('provider capacity parsing', () => {
  it('accepts valid capacity objects and rejects malformed or inconsistent ones', () => {
    assert.deepEqual(parseCapacity({ total: 8, used: 2, available: 6 }), { total: 8, used: 2, available: 6 });
    assert.deepEqual(parseCapacity({ total: 4, used: 4, available: 0, queued: 1 }), { total: 4, used: 4, available: 0, queued: 1 });
    for (const invalid of [
      null,
      [],
      { total: -1, used: 0, available: 0 },
      { total: 4, used: 5, available: 0 },
      { total: 4, used: 0, available: 5 },
      { total: 4, used: 0, available: 4, queued: -1 },
      { total: 4, used: 0, available: 4, extra: 1 },
      { total: '4', used: 0, available: 4 },
    ]) {
      assert.equal(parseCapacity(invalid), undefined, JSON.stringify(invalid));
    }
  });
});
