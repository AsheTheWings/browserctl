// A session's Playwright MCP worker. It runs as the session user, reads its configuration from fd 3, connects to
// the session's browser through its capability URL, and serves Playwright MCP over stdin and stdout.
//
// The configuration holds the capability URL, so it never travels in argv or the environment, which other users or
// child processes could read.

import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createConnection } from '@playwright/mcp';
import { chromium, type Page } from 'playwright-core';
import { CAPABILITIES } from '../mcp/allowlist.ts';

export interface WorkerConfig {
  endpoint: string;
  outputDir: string;
  downloadsDir: string;
  existing?: boolean;
}

const TITLE_TIMEOUT_MS = 1_500;

function guardPageTitle(page: Page): void {
  const original = page.title.bind(page);
  page.title = () =>
    Promise.race([
      original().catch(() => ''),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), TITLE_TIMEOUT_MS).unref()),
    ]);
}

const config = JSON.parse(readFileSync(3, 'utf8')) as WorkerConfig;
// Downloads land in the area the browser and session users share, where Playwright saves them into outputDir.
const browser = await chromium.connectOverCDP(config.endpoint, {
  artifactsDir: config.downloadsDir,
  ...(config.existing && { noDefaults: true }),
});
browser.on('disconnected', () => process.exit(0));
const attachedContext = browser.contexts()[0];
if (config.existing && !attachedContext) throw new Error('The existing browser has no default context.');
const context = attachedContext ?? (await browser.newContext());
if (config.existing) {
  for (const page of context.pages()) guardPageTitle(page);
  context.on('page', guardPageTitle);
}
const server = await createConnection(
  { browser: { isolated: false }, outputDir: config.outputDir, capabilities: [...CAPABILITIES], filePaths: 'relative' },
  async () => context,
);
const transport = new StdioServerTransport();
transport.onclose = () => process.exit(0);
await server.connect(transport);
