// Which Playwright MCP tools agents get. The worker enables these capabilities; the server lists and forwards only
// the allowlisted tools among them.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const CAPABILITIES = ['core', 'core-tabs', 'storage', 'network', 'pdf', 'vision', 'testing'] as const;

/** Every tool of those capabilities except browser_run_code_unsafe, which runs code in the worker, and
 * browser_close, which would end the session's browser under its owner. */
export const ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'browser_click', 'browser_console_messages', 'browser_cookie_clear', 'browser_cookie_delete', 'browser_cookie_get',
  'browser_cookie_list', 'browser_cookie_set', 'browser_drag', 'browser_drop', 'browser_emulate_media',
  'browser_evaluate', 'browser_file_upload', 'browser_fill_form', 'browser_find', 'browser_generate_locator',
  'browser_handle_dialog', 'browser_hover', 'browser_localstorage_clear', 'browser_localstorage_delete',
  'browser_localstorage_get', 'browser_localstorage_list', 'browser_localstorage_set', 'browser_mouse_click_xy',
  'browser_mouse_down', 'browser_mouse_drag_xy', 'browser_mouse_move_xy', 'browser_mouse_up', 'browser_mouse_wheel',
  'browser_navigate', 'browser_navigate_back', 'browser_network_request', 'browser_network_requests',
  'browser_network_state_set', 'browser_pdf_save', 'browser_press_key', 'browser_resize', 'browser_route',
  'browser_route_list', 'browser_select_option', 'browser_sessionstorage_clear', 'browser_sessionstorage_delete',
  'browser_sessionstorage_get', 'browser_sessionstorage_list', 'browser_sessionstorage_set',
  'browser_set_storage_state', 'browser_snapshot', 'browser_storage_state', 'browser_tabs', 'browser_take_screenshot',
  'browser_type', 'browser_unroute', 'browser_verify_element_visible', 'browser_verify_list_visible',
  'browser_verify_text_visible', 'browser_verify_value', 'browser_wait_for',
]);

let listed: Promise<Tool[]> | undefined;

/** The allowlisted tools' definitions, read once from Playwright MCP itself without starting a browser. */
export function playwrightTools(): Promise<Tool[]> {
  listed ??= (async () => {
    // Loaded on first use: Playwright is large, and most of the server never needs it.
    const { createConnection } = await import('@playwright/mcp');
    const server = await createConnection({ browser: { isolated: false }, capabilities: [...CAPABILITIES] }, async () => {
      throw new Error('listing tools needs no browser');
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'browserctl', version: '0' });
    await client.connect(clientSide);
    try {
      const { tools } = await client.listTools();
      return tools.filter((tool) => ALLOWED_TOOLS.has(tool.name));
    } finally {
      await client.close();
      await server.close();
    }
  })();
  return listed;
}
