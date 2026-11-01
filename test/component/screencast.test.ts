// The screencast client against a fake browser: the commands it sends, the page it shows, and its viewers' rates.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { connectBrowser, SCREENCAST_COMMANDS, Screencast } from '../../src/dashboard/screencast.ts';
import { eventually } from '../support/processes.ts';

/** A fake browser whose pages each paint a frame naming the page every few milliseconds once screencast. */
function fakeBrowser() {
  const methods: string[] = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let socket: WebSocket | undefined;
  const timers: NodeJS.Timeout[] = [];
  const send = (message: unknown) => socket?.send(JSON.stringify(message));
  server.on('connection', (connection) => {
    socket = connection;
    connection.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { id: number; method: string; params: any; sessionId?: string };
      methods.push(message.method);
      if (message.method === 'Target.setDiscoverTargets') send({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'A', type: 'page' } } });
      if (message.method === 'Target.attachToTarget') return send({ id: message.id, result: { sessionId: `session-${message.params.targetId}` } });
      if (message.method === 'Page.startScreencast') {
        const page = message.sessionId!.slice('session-'.length);
        timers.push(setInterval(() => send({ method: 'Page.screencastFrame', sessionId: message.sessionId, params: { data: Buffer.from(page).toString('base64'), sessionId: 1, metadata: { timestamp: Date.now() / 1000 } } }), 5));
      }
      send({ id: message.id, result: {} });
    });
  });
  return {
    listening: new Promise((resolve) => server.once('listening', resolve)),
    methods,
    url: () => `ws://127.0.0.1:${(server.address() as { port: number }).port}/devtools/browser/x`,
    openPage: (targetId: string) => send({ method: 'Target.targetCreated', params: { targetInfo: { targetId, type: 'page' } } }),
    close: async () => {
      timers.forEach(clearInterval);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('screencast', () => {
  let browser: ReturnType<typeof fakeBrowser>;

  before(async () => {
    browser = fakeBrowser();
    await browser.listening;
  });

  after(() => browser.close());

  it('sends only screencast commands, follows a newly opened page, and paces grid viewers', async () => {
    const screencast = new Screencast(() => connectBrowser(browser.url()));
    const seen = { grid: [] as string[], focused: [] as string[] };
    const viewer = (stream: 'grid' | 'focused') => ({ stream, send: (frame: { jpeg: Buffer }) => (seen[stream].push(frame.jpeg.toString()), true) });
    const stopGrid = screencast.watch(viewer('grid'));
    const stopFocused = screencast.watch(viewer('focused'));
    const started = Date.now();
    await eventually(() => seen.focused.length >= 100);
    const elapsed = Date.now() - started;
    assert.ok(seen.grid.length <= elapsed / 200 + 2, `grid paced near 5 fps: ${seen.grid.length} frames in ${elapsed} ms`);
    assert.ok(seen.focused.every((page) => page === 'A'));

    browser.openPage('B');
    await eventually(() => seen.focused.at(-1) === 'B');
    await eventually(() => seen.grid.at(-1) === 'B');
    stopGrid();
    stopFocused();
    assert.deepEqual([...new Set(browser.methods)].filter((method) => !SCREENCAST_COMMANDS.has(method)), []);
    assert.ok(browser.methods.includes('Page.screencastFrameAck'));
  });
});
