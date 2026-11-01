import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bearerToken, hashToken } from '../../src/auth/tokens.ts';
import { parseHeaders } from '../../src/telemetry/sdk.ts';

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
