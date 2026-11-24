import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPacScript,
  isLoopbackHost,
  parseAuthority,
  parseHostList,
  parsePortList,
} from '../../src/browser/loopback-proxy.ts';

describe('loopback proxy helpers', () => {
  it('parses single ports and ranges and rejects malformed entries', () => {
    assert.deepEqual([...parsePortList('')], []);
    assert.deepEqual([...parsePortList('8317, 15432, 3000-3002')], [8317, 15432, 3000, 3001, 3002]);
    for (const bad of ['0', '65536', '3002-3000', 'abc', '80,', '80-abc']) {
      assert.throws(() => parsePortList(bad), bad);
    }
  });

  it('parses extra loopback hostnames and checks loopback membership', () => {
    assert.deepEqual(parseHostList(''), []);
    assert.deepEqual(parseHostList('Dev-Host, dev-host, app.local'), ['dev-host', 'app.local']);
    for (const bad of ['bad host', 'http://a', ',a']) {
      assert.throws(() => parseHostList(bad), bad);
    }
    const extra = new Set(['dev-host']);
    for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', 'dev-host', 'DEV-HOST']) {
      assert.equal(isLoopbackHost(host, extra), true, host);
    }
    for (const host of ['example.com', '10.0.0.1', '127.0.0.2']) {
      assert.equal(isLoopbackHost(host, extra), false, host);
    }
  });

  it('parses CONNECT authorities for IPv4, hostnames, and IPv6', () => {
    assert.deepEqual(parseAuthority('127.0.0.1:5173'), { host: '127.0.0.1', port: 5173 });
    assert.deepEqual(parseAuthority('[::1]:8792'), { host: '::1', port: 8792 });
    assert.deepEqual(parseAuthority('dev-host:3000'), { host: 'dev-host', port: 3000 });
    for (const bad of ['127.0.0.1', '127.0.0.1:0', '127.0.0.1:99999', '[::1]']) {
      assert.equal(parseAuthority(bad), undefined, bad);
    }
  });

  it('builds a PAC script routing only loopback and configured hosts through the proxy', () => {
    const pac = buildPacScript('127.16.1.2', 18792, ['dev-host']);
    assert.match(pac, /PROXY 127\.16\.1\.2:18792/);
    assert.match(pac, /"dev-host"/);
    assert.match(pac, /return "DIRECT"/);
  });
});
