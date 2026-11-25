import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { inlineActionSnapshot, MAX_INLINE_SNAPSHOT_BYTES } from '../../src/mcp/snapshot.ts';

describe('inlineActionSnapshot', () => {
  const sampleResult: CallToolResult = {
    content: [{
      type: 'text',
      text: '### Page\n- Page URL: http://127.0.0.1:5173/\n### Snapshot\n- [Snapshot](./page-2026-11-25.yml)\n### Events\n- Done',
    }],
  };

  it('replaces an action snapshot link with fenced YAML, preserving dollar sequences and fences', async () => {
    const requested: string[] = [];
    const yaml = '- heading "Price $& $$ $10"\n- code "```ts"\n';
    const inlined = await inlineActionSnapshot('browser_navigate', sampleResult, async (name) => {
      requested.push(name);
      return Buffer.from(yaml, 'utf8');
    });
    assert.deepEqual(requested, ['./page-2026-11-25.yml']);
    assert.equal(
      inlined.content[0]!.type === 'text' && inlined.content[0]!.text,
      '### Page\n- Page URL: http://127.0.0.1:5173/\n### Snapshot\n````yaml\n- heading "Price $& $$ $10"\n- code "```ts"\n````\n### Events\n- Done',
    );
  });

  it('keeps the file link with a hint when the snapshot exceeds the inline cap', async () => {
    const oversized = Buffer.alloc(MAX_INLINE_SNAPSHOT_BYTES + 1, 97);
    const result = await inlineActionSnapshot('browser_click', sampleResult, async () => oversized);
    assert.equal(
      result.content[0]!.type === 'text' && result.content[0]!.text,
      `### Page\n- Page URL: http://127.0.0.1:5173/\n### Snapshot\n- [Snapshot](./page-2026-11-25.yml) (${oversized.length} bytes; call browser_snapshot with root or depth to inspect)\n### Events\n- Done`,
    );
  });

  it('skips browser_snapshot, error results, and results without a snapshot link', async () => {
    let calls = 0;
    const read = async () => {
      calls += 1;
      return Buffer.from('unused');
    };
    const errored: CallToolResult = { ...sampleResult, isError: true };
    const noLink: CallToolResult = { content: [{ type: 'text', text: '### Result\nok' }] };

    assert.equal(await inlineActionSnapshot('browser_snapshot', sampleResult, read), sampleResult);
    assert.equal(await inlineActionSnapshot('browser_click', errored, read), errored);
    assert.equal(await inlineActionSnapshot('browser_click', noLink, read), noLink);
    assert.equal(calls, 0);
  });

  it('falls back to the original result when reading the snapshot file fails', async () => {
    const result = await inlineActionSnapshot('browser_navigate', sampleResult, async () => {
      throw new Error('no such file');
    });
    assert.equal(result, sampleResult);
  });
});
