import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  MAX_PENDING_UPLOADS_PER_SESSION,
  MAX_SECRET_BYTES,
  MAX_SECRETS_PER_SESSION,
  parseEnvSecrets,
  parseUploadedSecrets,
  redactText,
  redactToolResult,
  resolveSecretPlaceholders,
  SessionSecretStore,
  substituteBrowserToolArgs,
  UPLOAD_TTL_MS,
} from '../../src/sessions/secrets.ts';

describe('secret parsing', () => {
  it('parses single-value uploads and trims one trailing newline by default', () => {
    const trimmed = parseUploadedSecrets(Buffer.from('s3cr3t!\r\n'), { format: 'value', name: 'APP_PASS', trimNewline: true });
    assert.deepEqual([...trimmed], [['APP_PASS', 's3cr3t!']]);

    const multi = parseUploadedSecrets(Buffer.from('line1\nline2\n'), { format: 'value', name: 'PEM', trimNewline: true });
    assert.deepEqual([...multi], [['PEM', 'line1\nline2']]);

    const raw = parseUploadedSecrets(Buffer.from('s3cr3t!\n'), { format: 'value', name: 'APP_PASS', trimNewline: false });
    assert.deepEqual([...raw], [['APP_PASS', 's3cr3t!\n']]);
  });

  it('rejects empty, oversized, or unnamed single-value uploads', () => {
    assert.throws(() => parseUploadedSecrets(Buffer.from('\n'), { format: 'value', name: 'APP_PASS', trimNewline: true }), /must not be empty/);
    assert.throws(() => parseUploadedSecrets(Buffer.alloc(MAX_SECRET_BYTES + 1, 65), { format: 'value', name: 'APP_PASS', trimNewline: true }), /limited to/);
    assert.throws(() => parseUploadedSecrets(Buffer.from('ok'), { format: 'value', name: '1bad', trimNewline: true }), /valid secret name/);
  });

  it('parses literal NAME=value env uploads and optional key filtering without echoing values on error', () => {
    const body = Buffer.from('# comment\n\nAPP_USER=alice\r\nAPP_PASS=p=a=s=s\n');
    const all = parseUploadedSecrets(body, { format: 'env', trimNewline: true });
    assert.deepEqual([...all], [['APP_USER', 'alice'], ['APP_PASS', 'p=a=s=s']]);

    const filtered = parseUploadedSecrets(body, { format: 'env', name: 'APP_PASS', trimNewline: true });
    assert.deepEqual([...filtered], [['APP_PASS', 'p=a=s=s']]);

    assert.throws(() => parseUploadedSecrets(body, { format: 'env', name: 'MISSING', trimNewline: true }), /not found/);
    assert.throws(() => parseEnvSecrets('# only comments\n\n'), /no secrets found/);
    assert.throws(() => parseEnvSecrets('A=1\nA=2\n'), /duplicate secret A/);
    assert.throws(() => parseEnvSecrets('EMPTY=\n'), /must not be empty/);
    assert.throws(
      () => parseEnvSecrets('1BAD=do-not-echo-this-secret\n'),
      (error: Error) => /invalid secret name/.test(error.message) && !error.message.includes('do-not-echo-this-secret'),
    );
    assert.throws(
      () => parseEnvSecrets('MALFORMED_LINE_NO_EQ_SECRET\n'),
      (error: Error) => /expected NAME=value/.test(error.message) && !error.message.includes('MALFORMED_LINE_NO_EQ_SECRET'),
    );
  });
});

describe('placeholder substitution and redaction', () => {
  const secrets = new Map([
    ['SHORT', 'abc'],
    ['LONG', "abc'def\"ghi\njkl"],
  ]);

  it('substitutes placeholders in browser_type and browser_fill_form without mutating input', () => {
    const typeArgs = { element: 'Password', ref: 'e1', text: '{{secret:LONG}}' };
    const resolvedType = substituteBrowserToolArgs('browser_type', typeArgs, secrets);
    assert.equal(resolvedType.text, "abc'def\"ghi\njkl");
    assert.equal(typeArgs.text, '{{secret:LONG}}');

    const fillArgs = {
      fields: [
        { name: 'User', type: 'textbox', ref: 'e1', value: 'prefix-{{secret:SHORT}}-suffix' },
        { name: 'Remember', type: 'checkbox', ref: 'e2', value: 'true' },
      ],
    };
    const resolvedFill = substituteBrowserToolArgs('browser_fill_form', fillArgs, secrets);
    assert.deepEqual((resolvedFill.fields as Array<{ value: string }>).map((field) => field.value), ['prefix-abc-suffix', 'true']);
    assert.equal(fillArgs.fields[0]!.value, 'prefix-{{secret:SHORT}}-suffix');

    const otherArgs = { url: 'https://example.test/{{secret:SHORT}}' };
    assert.equal(substituteBrowserToolArgs('browser_navigate', otherArgs, secrets), otherArgs);
  });

  it('fails closed on missing or malformed placeholders', () => {
    assert.throws(() => resolveSecretPlaceholders('{{secret:UNKNOWN}}', secrets), /UNKNOWN is not loaded/);
    assert.throws(() => resolveSecretPlaceholders('{{secret:UNKNOWN}}', new Map()), /UNKNOWN is not loaded/);
    assert.throws(() => resolveSecretPlaceholders('{{secret:}}', secrets), /invalid secret placeholder name/);
    assert.throws(() => resolveSecretPlaceholders('{{secret:bad name}}', secrets), /invalid secret placeholder name/);
  });

  it('redacts raw, JSON-escaped, and single-quoted JS-escaped secrets longest-first', () => {
    const raw = `raw=abc'def"ghi\njkl json=abc'def\\"ghi\\njkl js=abc\\'def"ghi\\njkl short=abc`;
    const redacted = redactText(raw, secrets);
    assert.equal(redacted, 'raw=<secret>LONG</secret> json=<secret>LONG</secret> js=<secret>LONG</secret> short=<secret>SHORT</secret>');

    const result: CallToolResult = {
      content: [
        { type: 'text', text: "await page.fill('abc\\'def\"ghi\\njkl');" },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    };
    const scrubbed = redactToolResult(result, secrets);
    assert.equal(scrubbed.content[0]!.type === 'text' && scrubbed.content[0]!.text, "await page.fill('<secret>LONG</secret>');");
    assert.deepEqual(scrubbed.content[1], result.content[1]);
  });
});

describe('SessionSecretStore', () => {
  it('enforces single-use, TTL, session liveness, caps, and cleanup', () => {
    const store = new SessionSecretStore();
    const now = 1_000_000;
    const { capability } = store.prepareUpload('s-1', 'agent-a', { format: 'value', name: 'PASS', trimNewline: true }, now);
    const uploaded = store.consumeUpload(capability, Buffer.from('top-secret\n'), (id) => id === 's-1', now + 100);
    assert.deepEqual(uploaded, { sessionId: 's-1', client: 'agent-a', loaded: ['PASS'] });
    assert.deepEqual(store.list('s-1'), ['PASS']);
    assert.equal(store.getMap('s-1').get('PASS'), 'top-secret');

    // Single-use: reusing the same capability fails.
    assert.throws(() => store.consumeUpload(capability, Buffer.from('again'), () => true, now + 200), /invalid or expired/);

    // Expired upload fails.
    const expired = store.prepareUpload('s-1', 'agent-a', { format: 'value', name: 'EXPIRED', trimNewline: true }, now);
    assert.throws(() => store.consumeUpload(expired.capability, Buffer.from('x'), () => true, now + UPLOAD_TTL_MS), /invalid or expired/);

    // Closed session fails.
    const closed = store.prepareUpload('s-2', 'agent-b', { format: 'value', name: 'PASS', trimNewline: true }, now);
    assert.throws(() => store.consumeUpload(closed.capability, Buffer.from('x'), () => false, now + 10), /invalid or expired/);

    // Pending upload cap per session.
    for (let index = 0; index < MAX_PENDING_UPLOADS_PER_SESSION; index += 1) {
      store.prepareUpload('s-cap', 'agent-a', { format: 'value', name: `K${index}`, trimNewline: true }, now);
    }
    assert.throws(() => store.prepareUpload('s-cap', 'agent-a', { format: 'value', name: 'EXTRA', trimNewline: true }, now), /too many pending/);

    // Secret count cap per session, while overwriting an existing key succeeds.
    const envLines = Array.from({ length: MAX_SECRETS_PER_SESSION }, (_, index) => `S_${index}=v${index}`).join('\n');
    const bulk = store.prepareUpload('s-full', 'agent-a', { format: 'env', trimNewline: true }, now);
    store.consumeUpload(bulk.capability, Buffer.from(envLines), () => true, now + 1);
    const overwrite = store.prepareUpload('s-full', 'agent-a', { format: 'value', name: 'S_0', trimNewline: true }, now);
    store.consumeUpload(overwrite.capability, Buffer.from('updated'), () => true, now + 2);
    assert.equal(store.getMap('s-full').get('S_0'), 'updated');
    const overflow = store.prepareUpload('s-full', 'agent-a', { format: 'value', name: 'OVERFLOW', trimNewline: true }, now);
    assert.throws(() => store.consumeUpload(overflow.capability, Buffer.from('x'), () => true, now + 3), /at most/);

    // Clear and deleteSession.
    assert.deepEqual(store.clear('s-1', 'NOPE'), []);
    assert.deepEqual(store.clear('s-1', 'PASS'), ['PASS']);
    assert.deepEqual(store.list('s-1'), []);
    store.deleteSession('s-full');
    assert.deepEqual(store.list('s-full'), []);
  });
});
