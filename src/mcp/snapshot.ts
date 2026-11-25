// Inline small action snapshot YAML files written by Playwright MCP into tool results, so remote
// MCP clients receive updated page refs without an extra browser_snapshot call.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const MAX_INLINE_SNAPSHOT_BYTES = 16 * 1024;

const ACTION_SNAPSHOT_LINK = /(^|\n)(### Snapshot\n)- \[Snapshot\]\(([^)\r\n]+)\)(?=\n|$)/;

function fenceFor(content: string): string {
  let maxRun = 2;
  for (const match of content.matchAll(/`+/g)) {
    if (match[0].length > maxRun) maxRun = match[0].length;
  }
  return '`'.repeat(maxRun + 1);
}

/** Replace an action tool's `- [Snapshot](path)` link with fenced YAML when within the inline cap. */
export async function inlineActionSnapshot(
  toolName: string,
  result: CallToolResult,
  readSnapshot: (filename: string) => Promise<Buffer>,
  maxBytes = MAX_INLINE_SNAPSHOT_BYTES,
): Promise<CallToolResult> {
  if (toolName === 'browser_snapshot' || result.isError) return result;
  let changed = false;
  const content = await Promise.all(result.content.map(async (item) => {
    if (item.type !== 'text') return item;
    const match = ACTION_SNAPSHOT_LINK.exec(item.text);
    if (!match) return item;
    const [full, lead, heading, target] = match;
    try {
      const bytes = await readSnapshot(target!);
      const replacement = bytes.length > maxBytes
        ? `${lead}${heading}- [Snapshot](${target}) (${bytes.length} bytes; call browser_snapshot with root or depth to inspect)`
        : (() => {
            const yaml = bytes.toString('utf8').replace(/\n+$/, '');
            const fence = fenceFor(yaml);
            return `${lead}${heading}${fence}yaml\n${yaml}\n${fence}`;
          })();
      changed = true;
      return {
        ...item,
        text: item.text.slice(0, match.index) + replacement + item.text.slice(match.index + full.length),
      };
    } catch {
      return item;
    }
  }));
  return changed ? { ...result, content } : result;
}
