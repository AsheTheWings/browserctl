// Attach the captured screenshot bytes as an MCP image content block when browser_take_screenshot saves
// to an explicit filename and the worker result omits the image block.

import { posix } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type ScreenshotFormat = 'png' | 'jpeg' | 'webp';

/** Infer the screenshot MIME type using the same precedence as Playwright MCP's browser_take_screenshot. */
export function screenshotMimeType(args: Record<string, unknown>): `image/${ScreenshotFormat}` {
  if (args.type === 'png' || args.type === 'jpeg' || args.type === 'webp') {
    return `image/${args.type}`;
  }
  if (typeof args.filename === 'string') {
    switch (posix.extname(args.filename).toLowerCase()) {
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.webp':
        return 'image/webp';
      case '.png':
        return 'image/png';
    }
  }
  return 'image/png';
}

/** Append an MCP image content block for a named browser_take_screenshot when the worker returned none. */
export async function attachScreenshotImage(
  toolName: string,
  args: Record<string, unknown>,
  result: CallToolResult,
  readScreenshot: (filename: string) => Promise<Buffer>,
): Promise<CallToolResult> {
  if (toolName !== 'browser_take_screenshot' || result.isError) return result;
  if (result.content.some((item) => item.type === 'image')) return result;
  if (typeof args.filename !== 'string' || args.filename.length === 0) return result;
  try {
    const data = await readScreenshot(args.filename);
    return {
      ...result,
      content: [
        ...result.content,
        { type: 'image', data: data.toString('base64'), mimeType: screenshotMimeType(args) },
      ],
    };
  } catch {
    return result;
  }
}
