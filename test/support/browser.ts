// Driving managed browsers directly in integration tests, through the server's own pipe connection.

import { launchChrome } from '../../src/browser/chrome.ts';
import { chromeBrowser, WINDOW, type DisplayOpener, type Session } from '../../src/sessions/manager.ts';
import { eventually } from './processes.ts';

/** Navigate a new or selected page over the server's pipe and return its CDP session once it loads. */
export async function visit(session: Session, url: string, existingTarget?: string): Promise<string> {
  const cdp = session.browser!.cdp!;
  const targetId = existingTarget ?? (await cdp.call<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
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
  return sessionId;
}

/** Wait for Chrome's initial tab; Browser.getVersion can answer before it exists. */
export async function visitStartupTab(session: Session, url: string): Promise<string> {
  const cdp = session.browser!.cdp!;
  let targetId: string | undefined;
  await eventually(async () => {
    const { targetInfos } = await cdp.call<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets');
    targetId = targetInfos.find((target) => target.type === 'page' && target.url === 'about:blank')?.targetId;
    return targetId !== undefined;
  });
  return visit(session, url, targetId!);
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
