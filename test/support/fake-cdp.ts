// A fake browser behind a CdpTransport: enough of the Target domain to exercise the relay's session routing.

import { CdpConnection, type CdpMessage, type CdpTransport } from '../../src/browser/cdp.ts';

export interface FakeBrowser {
  cdp: CdpConnection;
  /** Every message the browser received. */
  received: CdpMessage[];
  /** Emit an event on a session. */
  emit(sessionId: string, method: string, params?: Record<string, unknown>): void;
  detached: string[];
  close(): void;
}

export function fakeBrowser(): FakeBrowser {
  const listeners: Array<(text: string) => void> = [];
  const closers: Array<() => void> = [];
  const received: CdpMessage[] = [];
  const detached: string[] = [];
  let sessions = 0;
  const deliver = (message: CdpMessage) => queueMicrotask(() => listeners.forEach((listener) => listener(JSON.stringify(message))));
  const transport: CdpTransport = {
    send(text) {
      const message = JSON.parse(text) as CdpMessage;
      received.push(message);
      const reply = (result: Record<string, unknown>) => deliver({ id: message.id, result, ...(message.sessionId && { sessionId: message.sessionId }) });
      switch (message.method) {
        case 'Browser.getVersion':
          return reply({ product: 'FakeChrome/1', protocolVersion: '1.3', userAgent: 'fake', jsVersion: '1' });
        case 'Target.attachToBrowserTarget':
          return reply({ sessionId: `browser-${++sessions}` });
        case 'Target.attachToTarget': {
          const child = `page-${++sessions}`;
          reply({ sessionId: child });
          return deliver({ method: 'Target.attachedToTarget', params: { sessionId: child }, sessionId: message.sessionId });
        }
        case 'Target.setAutoAttach': {
          const child = `auto-${++sessions}`;
          reply({});
          return deliver({ method: 'Target.attachedToTarget', params: { sessionId: child }, sessionId: message.sessionId });
        }
        case 'Target.detachFromTarget':
          detached.push(String(message.params?.sessionId));
          return reply({});
        default:
          return reply({ echo: message.method, on: message.sessionId ?? null });
      }
    },
    onMessage: (listener) => listeners.push(listener),
    onClose: (listener) => closers.push(listener),
    close: () => closers.forEach((closer) => closer()),
  };
  const cdp = new CdpConnection(transport);
  return {
    cdp,
    received,
    detached,
    emit: (sessionId, method, params = {}) => deliver({ method, params, sessionId }),
    close: () => transport.close(),
  };
}
