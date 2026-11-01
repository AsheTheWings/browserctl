// The guides the MCP endpoint serves as resources: the installed e2e package's guides to writing tests and agent
// steps, and browserctl's guide to the task contract.

import { readFile } from 'node:fs/promises';
import { BrowserctlError } from '../errors.ts';

const E2E_REFERENCES = new URL('../skills/e2e/references/', import.meta.resolve('e2e'));
const DOCS = new URL('../../docs/', import.meta.url);

export interface Guide {
  uri: string;
  name: string;
  description: string;
  file: URL;
}

export const GUIDES: Guide[] = [
  {
    uri: 'browserctl://guides/tasks',
    name: 'tasks',
    description: 'The browserctl task contract: inputs, outputs, the bound browser, the replay cache, and run results.',
    file: new URL('tasks.md', DOCS),
  },
  {
    uri: 'browserctl://guides/e2e-writing-tests',
    name: 'e2e-writing-tests',
    description: 'The e2e guide to writing test files: registration, fixtures, locators, and expect.',
    file: new URL('writing-tests.md', E2E_REFERENCES),
  },
  {
    uri: 'browserctl://guides/e2e-agent',
    name: 'e2e-agent',
    description: 'The e2e guide to agent steps: act, assert, waitFor, extract, budgets, and the replay cache.',
    file: new URL('agent.md', E2E_REFERENCES),
  },
];

export async function readGuide(uri: string): Promise<string> {
  const guide = GUIDES.find((entry) => entry.uri === uri);
  if (!guide) throw new BrowserctlError('not_found', `no resource ${uri}`);
  return readFile(guide.file, 'utf8');
}
