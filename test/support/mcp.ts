// An MCP client of a test server's /mcp endpoint.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface TestClient {
  client: Client;
  transport: StreamableHTTPClientTransport;
  /** Call a tool and return its text and whether it was refused. */
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean; json: () => any }>;
  close(): Promise<void>;
}

export async function mcpClient(port: number, token: string): Promise<TestClient> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'browserctl-test', version: '0' });
  await client.connect(transport);
  return {
    client,
    transport,
    async call(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as CallToolResult;
      const text = result.content.map((item) => (item.type === 'text' ? item.text : `[${item.type}]`)).join('\n');
      return { text, isError: result.isError === true, json: () => JSON.parse(text) };
    },
    async close() {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    },
  };
}
