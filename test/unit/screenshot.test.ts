import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { attachScreenshotImage, screenshotMimeType } from '../../src/mcp/screenshot.ts';

describe('screenshotMimeType', () => {
  it('prefers an explicit type over the filename extension', () => {
    assert.equal(screenshotMimeType({ type: 'webp', filename: 'view.png' }), 'image/webp');
    assert.equal(screenshotMimeType({ type: 'jpeg', filename: 'view.webp' }), 'image/jpeg');
    assert.equal(screenshotMimeType({ type: 'png', filename: 'view.jpg' }), 'image/png');
  });

  it('infers format from the filename extension and defaults to png', () => {
    assert.equal(screenshotMimeType({ filename: 'view.png' }), 'image/png');
    assert.equal(screenshotMimeType({ filename: 'shots/view.jpg' }), 'image/jpeg');
    assert.equal(screenshotMimeType({ filename: 'shots/VIEW.JPEG' }), 'image/jpeg');
    assert.equal(screenshotMimeType({ filename: 'view.webp' }), 'image/webp');
    assert.equal(screenshotMimeType({ filename: 'shots.jpg/view' }), 'image/png');
    assert.equal(screenshotMimeType({ filename: 'view.bmp' }), 'image/png');
    assert.equal(screenshotMimeType({}), 'image/png');
  });
});

describe('attachScreenshotImage', () => {
  const textOnly: CallToolResult = { content: [{ type: 'text', text: '### Result\n- [Screenshot of viewport](./shot.png)' }] };

  it('appends an image block for named browser_take_screenshot results that omit one', async () => {
    const requested: string[] = [];
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const attached = await attachScreenshotImage(
      'browser_take_screenshot',
      { filename: 'shots/live.jpg', scale: 'css' },
      textOnly,
      async (name) => {
        requested.push(name);
        return bytes;
      },
    );
    assert.deepEqual(requested, ['shots/live.jpg']);
    assert.deepEqual(attached, {
      content: [
        textOnly.content[0],
        { type: 'image', data: bytes.toString('base64'), mimeType: 'image/jpeg' },
      ],
    });
  });

  it('leaves other tools, errors, unnamed calls, and existing image results untouched', async () => {
    let calls = 0;
    const read = async () => {
      calls += 1;
      return Buffer.from('unused');
    };
    const withImage: CallToolResult = {
      content: [textOnly.content[0]!, { type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    };
    const errored: CallToolResult = { ...textOnly, isError: true };

    assert.equal(await attachScreenshotImage('browser_snapshot', { filename: 'a.yml' }, textOnly, read), textOnly);
    assert.equal(await attachScreenshotImage('browser_take_screenshot', { filename: 'a.png' }, errored, read), errored);
    assert.equal(await attachScreenshotImage('browser_take_screenshot', { filename: 'a.png' }, withImage, read), withImage);
    assert.equal(await attachScreenshotImage('browser_take_screenshot', { scale: 'css' }, textOnly, read), textOnly);
    assert.equal(await attachScreenshotImage('browser_take_screenshot', { filename: '' }, textOnly, read), textOnly);
    assert.equal(calls, 0);
  });

  it('returns the original result when reading the saved screenshot fails', async () => {
    const fallback = await attachScreenshotImage(
      'browser_take_screenshot',
      { filename: 'huge.png' },
      textOnly,
      async () => {
        throw new Error('files are limited to 26214400 bytes');
      },
    );
    assert.equal(fallback, textOnly);
  });
});
