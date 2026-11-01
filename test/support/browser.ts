// Driving managed browsers directly in integration tests, through the server's own pipe connection.

import { launchChrome } from '../../src/browser/chrome.ts';
import { chromeBrowser, WINDOW, type DisplayOpener, type Session } from '../../src/sessions/manager.ts';

/** Open a page through the server's own pipe connection and wait for it to load. */
export async function visit(session: Session, url: string): Promise<void> {
  const cdp = session.browser!.cdp!;
  const { targetId } = await cdp.call<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.call<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  await cdp.call('Page.enable', {}, sessionId);
  const loaded = new Promise<void>((resolve) => {
    const stop = cdp.onEvent((event) => {
      if (event.sessionId === sessionId && event.method === 'Page.loadEventFired') {
        stop();
        resolve();
      }
    });
  });
  await cdp.call('Page.navigate', { url }, sessionId);
  await loaded;
}

export async function cookies(session: Session): Promise<string[]> {
  const { cookies: list } = await session.browser!.cdp!.call<{ cookies: Array<{ name: string; value: string }> }>('Storage.getCookies');
  return list.map((cookie) => `${cookie.name}=${cookie.value}`).sort();
}

/** Stands in for the sign-in module's headful browser: the same managed Chrome, headless over the pipe. */
export function headlessSignIn(path: string): DisplayOpener {
  return async (session) =>
    chromeBrowser(await launchChrome({
      userDataDir: session.workspace.profile, uid: session.users.browserUid, gid: session.users.gid,
      home: session.workspace.browserHome, temp: session.workspace.browserTemp, path,
      mode: { kind: 'pipe' }, windowSize: WINDOW,
    }));
}
