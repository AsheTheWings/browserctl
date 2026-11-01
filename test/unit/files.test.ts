import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { areaName } from '../../src/sessions/files.ts';

describe('file area names', () => {
  it('accepts relative names inside the area', () => {
    assert.equal(areaName('report.txt'), 'report.txt');
    assert.equal(areaName('uploads/in.txt'), 'uploads/in.txt');
    assert.equal(areaName('./a/b.png'), 'a/b.png');
  });

  it('refuses names that leave the area or name nothing', () => {
    for (const name of ['../x', 'a/../../x', '/etc/passwd', '..', '.', '', 'a\0b', 7, undefined, 'x'.repeat(1025)]) {
      assert.throws(() => areaName(name), /name/, String(name));
    }
  });
});
