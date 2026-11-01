import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RfbInputDetector } from '../../src/dashboard/vnc.ts';

const handshake = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1]), Buffer.from([1])]);
const setEncodings = Buffer.from([2, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 7]);
const updateRequest = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]);
const pointer = Buffer.from([5, 1, 0, 10, 0, 20]);

describe('RFB input detector', () => {
  it('tells keyboard and pointer input from protocol traffic', () => {
    const detector = new RfbInputDetector();
    assert.equal(detector.feed(handshake), false);
    assert.equal(detector.feed(Buffer.concat([setEncodings, updateRequest, updateRequest])), false);
    assert.equal(detector.feed(key), true);
    assert.equal(detector.feed(updateRequest), false);
    assert.equal(detector.feed(pointer), true);
  });

  it('follows messages split across chunks', () => {
    const detector = new RfbInputDetector();
    const stream = Buffer.concat([handshake, updateRequest, key, updateRequest]);
    const results = [...stream].map((byte) => detector.feed(Buffer.from([byte])));
    assert.equal(results.filter(Boolean).length, 1, 'the key event completes in exactly one chunk');
  });

  it('counts everything as input once it meets a message it cannot measure', () => {
    const detector = new RfbInputDetector();
    detector.feed(handshake);
    assert.equal(detector.feed(Buffer.from([77, 0, 0])), true);
    assert.equal(detector.feed(updateRequest), true);
  });
});
