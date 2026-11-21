// The screencast client against a fake browser: the commands it sends, the page it shows, and its viewers' rates.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { CdpConnection, type CdpMessage } from '../../src/browser/cdp.ts';
import { connectBrowser, SCREENCAST_COMMANDS, Screencast } from '../../src/dashboard/screencast.ts';
import { eventually } from '../support/processes.ts';
import { assertCataloged, memoryTelemetry } from '../support/telemetry.ts';

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

  it('shows the foreground tab even when a background tab sends a frame first', async () => {
    const telemetry = memoryTelemetry();
    let receive: (text: string) => void;
    const emit = (message: CdpMessage) => receive(JSON.stringify(message));
    let started = 0;
    let ready: () => void;
    const bothStarted = new Promise<void>((resolve) => { ready = resolve; });
    const cdp = new CdpConnection({
      onMessage(listener) { receive = listener; },
      onClose() {},
      close() {},
      send(text) {
        const { id, method, params } = JSON.parse(text) as CdpMessage;
        if (method === 'Target.setDiscoverTargets') {
          for (const targetId of ['A', 'B']) {
            emit({ method: 'Target.targetCreated', params: { targetInfo: { targetId, type: 'page' } } });
          }
        }
        emit({ id, result: method === 'Target.attachToTarget' ? { sessionId: params?.targetId } : {} });
        if (method === 'Page.startScreencast' && ++started === 2) ready();
      },
    });
    const visible = (sessionId: string, visible: boolean) =>
      emit({ method: 'Page.screencastVisibilityChanged', sessionId, params: { visible } });
    const frame = (sessionId: string) => emit({
      method: 'Page.screencastFrame',
      sessionId,
      params: { data: Buffer.from(sessionId).toString('base64'), sessionId: 1 },
    });
    const cast = new Screencast(async () => cdp, 'session-test');
    const frames: string[] = [];
    try {
      cast.watch({ stream: 'grid', send: ({ jpeg }) => (frames.push(jpeg.toString()), true) });
      await bothStarted;
      visible('A', false);
      visible('B', true);
      frame('A');
      frame('B');
      visible('A', true);
      visible('B', false);
      frame('B');
      frame('A');

      const signals = await telemetry.collect();
      assertCataloged(signals);
      const selections = signals.logs.filter(({ body }) => body === 'browserctl.screencast.tab_selected');
      assert.deepEqual(frames, ['B', 'A'], JSON.stringify(selections));
      assert.deepEqual(selections.map(({ attributes }) => attributes), Array.from({ length: 2 }, () => ({
        'browserctl.session.id': 'session-test',
        'browserctl.screencast.visibility': 'visible',
      })));
    } finally {
      cast.close();
      await telemetry.restore();
    }
  });

  it('traces a rejected screencast start separately from attachment', async () => {
    const telemetry = memoryTelemetry();
    let receive: (text: string) => void;
    const emit = (message: CdpMessage) => receive(JSON.stringify(message));
    const cdp = new CdpConnection({
      onMessage(listener) { receive = listener; },
      onClose() {},
      close() {},
      send(text) {
        const { id, method } = JSON.parse(text) as CdpMessage;
        if (method === 'Target.setDiscoverTargets') {
          emit({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'A', type: 'page' } } });
        }
        if (method === 'Page.startScreencast') {
          emit({ id, error: { code: -32000, message: 'Not attached to an active page' } });
        } else {
          emit({ id, result: method === 'Target.attachToTarget' ? { sessionId: 'tab' } : {} });
        }
      },
    });
    const cast = new Screencast(async () => cdp, 'session-test');
    try {
      cast.watch({ stream: 'grid', send: () => true });
      const failed = ({ name, attributes }: { name: string; attributes: Record<string, unknown> }) =>
        name === 'browserctl.screencast.capture_start' && attributes['error.type'] !== undefined;
      await eventually(async () => (await telemetry.collect()).spans.some(failed));
      const signals = await telemetry.collect();
      assertCataloged(signals);
      assert.deepEqual(signals.spans.find(failed)?.attributes, {
        'browserctl.session.id': 'session-test',
        'browserctl.screencast.stage': 'start',
        'browserctl.screencast.rejection': 'inactive_page',
        'error.type': 'browser_failed',
      });
    } finally {
      cast.close();
      await telemetry.restore();
    }
  });

  it('recovers a transient inactive page without a URL change', async () => {
    let receive: (text: string) => void;
    const emit = (message: CdpMessage) => receive(JSON.stringify(message));
    const starts: CdpMessage[] = [];
    const cdp = new CdpConnection({
      onMessage(listener) { receive = listener; },
      onClose() {},
      close() {},
      send(text) {
        const command = JSON.parse(text) as CdpMessage;
        const { id, method } = command;
        if (method === 'Target.setDiscoverTargets') {
          emit({ method: 'Target.targetCreated', params: { targetInfo: { type: 'page', targetId: 'A', url: 'https://fixture.example/page' } } });
        }
        if (method === 'Page.startScreencast') {
          starts.push(command);
          if (starts.length === 1) {
            emit({ id, error: { code: -32000, message: 'Not attached to an active page' } });
            return;
          }
        }
        emit({ id, result: method === 'Target.attachToTarget' ? { sessionId: 'tab' } : {} });
      },
    });
    const cast = new Screencast(async () => cdp);
    const frames: string[] = [];
    try {
      cast.watch({ stream: 'focused', send: ({ jpeg }) => (frames.push(jpeg.toString()), true) });
      await eventually(() => starts.length === 2);
      assert.deepEqual(starts.map(({ sessionId }) => sessionId), ['tab', 'tab']);
      emit({ method: 'Page.screencastFrame', sessionId: 'tab', params: { data: Buffer.from('recovered').toString('base64'), sessionId: 1 } });
      assert.deepEqual(frames, ['recovered']);
    } finally {
      cast.close();
    }
  });

  for (const navigationFirst of [true, false]) {
    it(`starts capture after navigation ${navigationFirst ? 'before' : 'after'} Chrome rejects the initial start`, async () => {
      let receive: (text: string) => void;
      const emit = (message: CdpMessage) => receive(JSON.stringify(message));
      const target = (url: string, method = 'Target.targetInfoChanged') =>
        emit({ method, params: { targetInfo: { type: 'page', targetId: 'A', url } } });
      const starts: CdpMessage[] = [];
      let attachCount = 0;
      const cdp = new CdpConnection({
        onMessage(listener) { receive = listener; },
        onClose() {},
        close() {},
        send(text) {
          const message = JSON.parse(text) as CdpMessage;
          const { id, method } = message;
          if (method === 'Target.setDiscoverTargets') target('about:blank', 'Target.targetCreated');
          if (method === 'Target.attachToTarget') attachCount++;
          if (method === 'Page.startScreencast') {
            starts.push(message);
            return;
          }
          emit({ id, result: method === 'Target.attachToTarget' ? { sessionId: 'tab' } : {} });
        },
      });
      const cast = new Screencast(async () => cdp, 'capture-test');
      const frames: string[] = [];
      try {
        cast.watch({ stream: 'grid', send: ({ jpeg }) => (frames.push(jpeg.toString()), true) });
        await eventually(() => starts.length === 1);
        const rejectStart = () =>
          emit({ id: starts[0]!.id, error: { code: -32000, message: 'Not attached to an active page' } });
        const navigate = () => target('https://fixture.example/page');
        if (navigationFirst) {
          navigate();
          assert.equal(starts.length, 1, 'navigation does not start another capture while a request is pending');
          rejectStart();
        } else {
          rejectStart();
          // Let the command rejection and span finish before simulating a later navigation.
          await new Promise<void>((resolve) => setImmediate(resolve));
          target('about:blank');
          assert.equal(starts.length, 1, 'unchanged target metadata does not restart capture');
          navigate();
        }
        await eventually(() => starts.length === 2);
        assert.equal(attachCount, 1, 'the target session is reused');
        assert.equal(starts[1]!.sessionId, 'tab');
        emit({ id: starts[1]!.id, result: {} });
        emit({ method: 'Page.screencastFrame', sessionId: 'tab', params: { data: Buffer.from('painted').toString('base64'), sessionId: 1 } });
        assert.deepEqual(frames, ['painted']);
        await new Promise<void>((resolve) => setImmediate(resolve));
        target('https://fixture.example/next');
        assert.equal(starts.length, 2, 'navigation does not restart a running capture');
      } finally {
        cast.close();
      }
    });
  }
});
