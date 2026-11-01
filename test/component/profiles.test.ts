import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ProfileStore } from '../../src/profiles/store.ts';
import { runDirectory } from '../support/server.ts';

async function tree(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true })).sort();
}

describe('profile store', () => {
  let run: Awaited<ReturnType<typeof runDirectory>>;
  let store: ProfileStore;
  before(async () => {
    run = await runDirectory();
    store = new ProfileStore(join(run.path, 'state'));
  });
  after(() => run.remove());

  it('creates a profile with an empty current first revision', async () => {
    const profile = await store.create('mail', 'operator');
    assert.equal(profile.current, '1');
    assert.deepEqual(profile.revisions.map((revision) => [revision.id, revision.client, revision.pinned]), [['1', 'operator', false]]);
    assert.deepEqual(await readdir(store.revisionPath('mail', '1')), []);
    await assert.rejects(store.create('mail', 'operator'), /exists/);
    await assert.rejects(store.create('Bad', 'operator'), /profile name/);
  });

  it('copies a new revision without caches or Singleton files and makes it current', async () => {
    const source = join(run.path, 'working');
    await mkdir(join(source, 'Default', 'Cache'), { recursive: true });
    await mkdir(join(source, 'GPUCache'), { recursive: true });
    await writeFile(join(source, 'Default', 'Cookies'), 'cookie-db');
    await writeFile(join(source, 'Default', 'Cache', 'data'), 'x');
    await writeFile(join(source, 'SingletonLock'), 'x');
    await writeFile(join(source, 'Local State'), '{}');
    const revision = await store.addRevision('mail', source, 'operator');
    assert.equal(revision.id, '2');
    assert.equal((await store.get('mail')).current, '2');
    assert.deepEqual(await tree(store.revisionPath('mail', '2')), ['Default', 'Default/Cookies', 'Local State']);

    const copy = join(run.path, 'copy');
    await mkdir(copy);
    assert.equal(await store.copyCurrent('mail', copy), '2');
    assert.equal(await readFile(join(copy, 'Default', 'Cookies'), 'utf8'), 'cookie-db');
  });

  it('keeps the current, pinned, and 5 newest revisions as revisions are added', async () => {
    const source = join(run.path, 'working');
    await store.setPinned('mail', '1', true);
    for (let index = 0; index < 6; index += 1) await store.addRevision('mail', source, 'operator');
    const profile = await store.get('mail');
    assert.deepEqual(profile.revisions.map((revision) => revision.id), ['1', '4', '5', '6', '7', '8']);
    assert.deepEqual((await readdir(join(run.path, 'state', 'profiles', 'mail', 'revisions'))).sort(), ['1', '4', '5', '6', '7', '8']);
    await store.setCurrent('mail', '4');
    await store.setPinned('mail', '1', false);
    await store.addRevision('mail', source, 'operator');
    assert.deepEqual((await store.get('mail')).revisions.map((revision) => revision.id), ['5', '6', '7', '8', '9']);
  });

  it('adds and removes services and deletes a profile', async () => {
    await store.addService('mail', 'inbox', 'check-inbox');
    await assert.rejects(store.addService('mail', 'inbox', 'check-inbox'), /exists/);
    assert.deepEqual((await store.get('mail')).services, [{ name: 'inbox', task: 'check-inbox' }]);
    await store.removeService('mail', 'inbox');
    await store.delete('mail');
    await assert.rejects(store.get('mail'), /no profile mail/);
    assert.deepEqual(await store.list(), []);
  });

  it('removes staging and unlisted revision directories an interrupted change left', async () => {
    await store.create('other', 'operator');
    const staging = join(run.path, 'state', 'profiles', 'other', 'revisions', '.staging-1234');
    await mkdir(staging);
    // A crash after a revision's rename and before its metadata, or during retention, leaves an unlisted revision.
    await mkdir(join(run.path, 'state', 'profiles', 'other', 'revisions', '2'));
    await store.sweepLeftovers();
    assert.deepEqual(await readdir(join(run.path, 'state', 'profiles', 'other', 'revisions')), ['1']);
    assert.equal((await store.addRevision('other', join(run.path, 'working'), 'operator')).id, '2');
  });
});
