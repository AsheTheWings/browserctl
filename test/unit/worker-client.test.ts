import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { ChildTransport } from '../../src/mcp/worker-client.ts';

describe('ChildTransport', () => {
  it('routes stdout and stdin pipe errors to onerror instead of crashing', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => undefined }),
      stdout: new EventEmitter(),
    });
    const transport = new ChildTransport(child as never);
    const errors: Error[] = [];
    transport.onerror = (error) => errors.push(error);
    await transport.start();

    const readReset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const writePipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    child.stdout.emit('error', readReset);
    child.stdin.emit('error', writePipe);

    assert.deepEqual(errors, [readReset, writePipe]);
  });
});
