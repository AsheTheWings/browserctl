import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isVolatile } from '../../src/profiles/copy.ts';
import { revisionsToDelete } from '../../src/profiles/retention.ts';

const revisions = (count: number, pinned: number[] = []) =>
  Array.from({ length: count }, (_, index) => ({ id: String(index + 1), sequence: index + 1, pinned: pinned.includes(index + 1) }));

describe('revision retention', () => {
  it('keeps the current, pinned, and 5 newest revisions and deletes the rest', () => {
    assert.deepEqual(revisionsToDelete(revisions(9, [2]), '1'), ['3', '4']);
  });

  it('deletes nothing while there are at most 5', () => {
    assert.deepEqual(revisionsToDelete(revisions(5), '5'), []);
  });

  it('keeps an older current revision and orders by sequence, not id text', () => {
    const marks = [
      { id: '10', sequence: 10, pinned: false },
      { id: '9', sequence: 9, pinned: false },
      ...revisions(8),
    ];
    assert.deepEqual(revisionsToDelete(marks, '2').sort(), ['1', '3', '4', '5']);
  });
});

describe('volatile profile files', () => {
  it('leaves out caches and Singleton files at any depth', () => {
    for (const path of ['SingletonLock', 'SingletonSocket', 'Default/Cache', 'Default/Code Cache', 'GPUCache', 'Default/GPUCache', 'ShaderCache', 'DevToolsActivePort']) {
      assert.equal(isVolatile(path), true, path);
    }
    for (const path of ['Default/Cookies', 'Local State', 'Default/Local Storage', 'Default/Preferences']) assert.equal(isVolatile(path), false, path);
  });
});
