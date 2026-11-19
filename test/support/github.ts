// Synthetic GitHub OAuth responses and helpers that sign in through the dashboard's HTTP routes.

import assert from 'node:assert/strict';

export const OWNER_ID = 42;
export const GITHUB_SECRET = 'synthetic-github-secret';

export function fakeGithub() {
  const requests: Request[] = [];
  const request: typeof fetch = async (input, init) => {
    const received = new Request(input, init);
    requests.push(received);
    switch (received.url) {
      case 'https://github.com/login/oauth/access_token': {
        const code = (await received.clone().formData()).get('code');
        if (code === 'unavailable') return new Response(null, { status: 503 });
        return Response.json({ access_token: `synthetic-${code}` });
      }
      case 'https://api.github.com/user':
        if (received.headers.get('authorization') === 'Bearer synthetic-malformed') {
          return Response.json({ id: String(OWNER_ID) });
        }
        return Response.json({ id: received.headers.get('authorization') === 'Bearer synthetic-owner' ? OWNER_ID : OWNER_ID + 1 });
      case 'https://api.github.com/applications/synthetic-client/token':
        return new Response(null, { status: 204 });
      default:
        throw new Error(`unexpected OAuth request: ${received.url}`);
    }
  };
  return { request, requests };
}

export async function startGithubSignIn(base: string) {
  const start = await fetch(`${base}/dashboard/login`, { redirect: 'manual' });
  assert.equal(start.status, 303);
  const authorization = new URL(start.headers.get('location')!);
  const callback = new URL(authorization.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', authorization.searchParams.get('state')!);
  callback.searchParams.set('code', 'owner');
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  return { start, authorization, callback, cookie };
}

export function finishGithubSignIn(base: string, callback: URL, cookie?: string) {
  return fetch(`${base}${callback.pathname}${callback.search}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
}

export async function signIn(base: string): Promise<string> {
  const { callback, cookie } = await startGithubSignIn(base);
  const login = await finishGithubSignIn(base, callback, cookie);
  assert.equal(login.status, 303);
  return login.headers.getSetCookie()[0]!.split(';')[0]!;
}
