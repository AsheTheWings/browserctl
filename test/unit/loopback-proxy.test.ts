import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chromeArguments } from '../../src/browser/chrome.ts';
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

  it('parses extra loopback hostnames and subdomain wildcards and checks loopback membership', () => {
    assert.deepEqual(parseHostList(''), []);
    assert.deepEqual(
      parseHostList('Dev-Host, dev-host, app.local, *.WG.Example.Invalid'),
      ['dev-host', 'app.local', '*.wg.example.invalid'],
    );
    for (const bad of ['bad host', 'http://a', ',a', '*', '*.', '*a.example', 'a.*.example', '*.a..b']) {
      assert.throws(() => parseHostList(bad), bad);
    }
    const extra = new Set(['dev-host', '*.wg.example.invalid']);
    for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', 'dev-host', 'DEV-HOST',
      'app.wg.example.invalid', 'SUB.APP.WG.EXAMPLE.INVALID']) {
      assert.equal(isLoopbackHost(host, extra), true, host);
    }
    for (const host of ['example.com', '10.0.0.1', '127.0.0.2', 'wg.example.invalid', 'notwg.example.invalid']) {
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

  it('builds a PAC script routing only loopback, exact hosts, and wildcard subdomains through the proxy', () => {
    const pac = buildPacScript('127.16.1.2', 18792, ['dev-host', '*.wg.example.invalid']);
    const findProxy = new Function(`${pac}; return FindProxyForURL;`)() as (url: string, host: string) => string;
    assert.equal(findProxy('http://127.0.0.1:5173/', '127.0.0.1'), 'PROXY 127.16.1.2:18792');
    assert.equal(findProxy('http://localhost:5173/', 'localhost'), 'PROXY 127.16.1.2:18792');
    assert.equal(findProxy('http://dev-host:5173/', 'Dev-Host'), 'PROXY 127.16.1.2:18792');
    assert.equal(findProxy('https://app.wg.example.invalid/', 'app.wg.example.invalid'), 'PROXY 127.16.1.2:18792');
    assert.equal(findProxy('https://wg.example.invalid/', 'wg.example.invalid'), 'DIRECT');
    assert.equal(findProxy('https://evilwg.example.invalid/', 'evilwg.example.invalid'), 'DIRECT');
    assert.equal(findProxy('https://example.com/', 'example.com'), 'DIRECT');
  });

  it('passes --proxy-server and --proxy-bypass-list=<-loopback> whenever a proxy server is configured', () => {
    const base = {
      userDataDir: '/tmp/profile',
      uid: 1101,
      gid: 1301,
      home: '/tmp/home',
      temp: '/tmp/tmp',
      path: '/usr/bin',
      mode: { kind: 'pipe' as const },
      windowSize: { width: 1280, height: 800 },
    };
    assert.equal(chromeArguments(base).includes('--proxy-bypass-list=<-loopback>'), false);
    const proxied = chromeArguments({ ...base, proxyServer: 'http://127.16.1.2:18792' });
    assert.ok(proxied.includes('--proxy-server=http://127.16.1.2:18792'));
    assert.ok(proxied.includes('--proxy-bypass-list=<-loopback>'));
  });
});
