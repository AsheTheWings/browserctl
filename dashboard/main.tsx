import { Clapperboard, DoorOpen, Eye, EyeOff, Globe, LayoutGrid, Moon, Sun, UsersRound, Workflow } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { api, dashboard, errorMessage, post, type State } from './api.ts';
import { isPreviewEnded, Viewer, type Preview } from './preview.tsx';
import { Overview, Profiles, Providers, Recordings, Tasks } from './sections.tsx';
import { Button } from './ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card.tsx';
import { Input } from './ui/input.tsx';
import './main.css';

const nav = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid },
  { id: 'profiles', label: 'Profiles', icon: UsersRound },
  { id: 'tasks', label: 'Tasks', icon: Workflow },
  { id: 'recordings', label: 'Recordings', icon: Clapperboard },
  { id: 'providers', label: 'Providers', icon: Globe },
] as const;
type Page = typeof nav[number];
type Theme = 'light' | 'dark';

const media = matchMedia('(prefers-color-scheme: dark)');
const systemTheme = (): Theme => media.matches ? 'dark' : 'light';

document.documentElement.dataset.theme = systemTheme();

function ThemeButton({ sidebar = false }: { sidebar?: boolean }) {
  const [theme, setTheme] = useState(systemTheme);
  useEffect(() => {
    const update = () => setTheme(systemTheme());
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  const next = theme === 'light' ? 'dark' : 'light';
  return (
    <Button variant="ghost" size={sidebar ? "sm" : "icon-sm"} className={sidebar ? "sidebar-action" : undefined}
      aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}>
      {theme === 'light' ? <Moon aria-hidden /> : <Sun aria-hidden />}
      {sidebar && <span className="sidebar-label">{next === 'dark' ? 'Dark theme' : 'Light theme'}</span>}
    </Button>
  );
}

function Brand() {
  return <div className="flex items-center gap-2.5">
    <span className="brand-mark" aria-hidden="true">b</span>
    <span className="brand-label text-base font-semibold tracking-tight">browserctl</span>
  </div>;
}

function SignIn({ method }: { method: 'password' | 'github' }) {
  const [error, setError] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get('password');
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${dashboard}login`, post({ password }));
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        setError(result.error ?? 'Could not sign in.');
        return;
      }
      location.replace(dashboard);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative grid min-h-dvh place-items-center px-5 py-20">
      <div className="absolute top-5 right-5"><ThemeButton /></div>
      <Card className="sign-in-card gap-5 rounded-xl py-6">
        <CardHeader className={method === 'github' ? 'justify-items-center text-center' : 'gap-4'}>
          {method === 'github' ? <span className="brand-mark mb-1" aria-hidden="true">b</span> : <Brand />}
          <CardTitle>
            <h1 className="text-xl leading-tight font-semibold tracking-tight">
              {method === 'github' ? 'Sign in to Browserctl' : 'Sign in'}
            </h1>
          </CardTitle>
          {method === 'github' && <CardDescription>Use the configured GitHub account.</CardDescription>}
        </CardHeader>
        <CardContent className="px-6">
          {method === 'password' ? (
            <form onSubmit={(event) => void signIn(event)} className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="password" className="block font-medium">Development password</label>
                <div className="relative">
                  <Input id="password" name="password" type={visible ? 'text' : 'password'} autoComplete="current-password"
                    aria-invalid={Boolean(error)} aria-describedby={error ? 'sign-in-error' : undefined}
                    className="pr-10" required />
                  <Button type="button" variant="ghost" size="icon-sm" className="absolute top-0.5 right-0.5"
                    aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(!visible)}>
                    {visible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                  </Button>
                </div>
              </div>
              {error && <p id="sign-in-error" role="alert" className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
            </form>
          ) : (
            <Button asChild variant="outline" className="w-full">
              <a href={`${dashboard}login`}>
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                  <path d="M 12 .5 a 12 12 0 0 0 -3.8 23.4 c .6 .1 .8 -.3 .8 -.6 v -2.2
                    c -3.3 .7 -4 -1.4 -4 -1.4 -.5 -1.4 -1.3 -1.8 -1.3 -1.8 -1.1 -.8 .1 -.8 .1 -.8 1.2 .1 1.9 1.3 1.9 1.3 1 1.9 2.8 1.4 3.4 1 .1 -.8 .4 -1.4 .8 -1.7 -2.7 -.3 -5.5 -1.3 -5.5 -6
                    a 4.7 4.7 0 0 1 1.2 -3.2
                    c -.1 -.3 -.5 -1.6 .1 -3.3 0 0 1 -.3 3.3 1.2 a 11.4 11.4 0 0 1 6 0
                    c 2.3 -1.5 3.3 -1.2 3.3 -1.2 .6 1.7 .2 3 .1 3.3
                    a 4.7 4.7 0 0 1 1.2 3.2 c 0 4.7 -2.8 5.7 -5.5 6 .4 .4 .8 1.1 .8 2.2
                    v 3.4 c 0 .3 .2 .7 .8 .6 A 12 12 0 0 0 12 .5 Z" />
                </svg>
                Continue with GitHub
              </a>
            </Button>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

const currentPage = (): Page => nav.find((page) => `#${page.id}` === location.hash) ?? nav[0];

function Workspace() {
  const [page, setPage] = useState<Page>(currentPage);
  const [data, setData] = useState<State>();
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [preview, setPreview] = useState<Preview>();
  const openPreview = (next: Preview) => { setActionError(''); setPreview(next); };
  const closePreview = useCallback(() => setPreview(undefined), []);
  const pending = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    try {
      const next = await api<State>('/state', { signal: request.signal });
      if (!request.signal.aborted) { setData(next); setLoadError(''); }
    } catch (error) {
      if (!request.signal.aborted) setLoadError(errorMessage(error));
    } finally {
      if (pending.current === request) pending.current = null;
    }
  }, []);

  useEffect(() => {
    const navigate = () => setPage(currentPage());
    addEventListener('hashchange', navigate);
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !pending.current) void refresh();
    }, 3000);
    return () => {
      removeEventListener('hashchange', navigate);
      clearInterval(timer);
      pending.current?.abort();
    };
  }, [refresh]);

  async function mutate<T>(path: string, payload: unknown = {}): Promise<T> {
    const result = await api<T>(path, post(payload));
    if (path === '/logout') location.replace(dashboard);
    else await refresh();
    return result;
  }

  async function change<T>(path: string, payload?: unknown): Promise<T | undefined> {
    setActionError('');
    try {
      return await mutate<T>(path, payload);
    } catch (error) {
      setActionError(errorMessage(error));
      return undefined;
    }
  }

  const client = data?.client === 'dashboard:development' ? 'Development session' : data?.client?.replace('github:', 'GitHub · ');
  function content() {
    if (!data) return loadError
      ? <Button variant="outline" onClick={() => void refresh()}>Try again</Button>
      : <p role="status" className="text-muted-foreground">Loading dashboard…</p>;
    switch (page.id) {
      case 'overview': return <Overview state={data} open={openPreview} />;
      case 'profiles': return <Profiles state={data} change={change} open={openPreview} />;
      case 'tasks': return <Tasks state={data} report={setActionError} />;
      case 'recordings': return <Recordings rows={data.recordings} open={openPreview} />;
      case 'providers': return <Providers rows={data.providers} />;
    }
  }

  return (
    <div className="shell grid grid-cols-1 grid-rows-[auto_1fr] md:grid-rows-[1fr]">
      <aside className="sidebar z-10 border-b md:sticky md:top-0 md:h-dvh md:border-r md:border-b-0">
        <div className="sidebar-header">
          <a href="#overview" aria-label="Browserctl overview"><Brand /></a>
        </div>
        <nav aria-label="Dashboard" className="sidebar-nav">
          {nav.map(({ id, label, icon: Icon }) => (
            <a key={id} href={`#${id}`} aria-current={page.id === id ? 'page' : undefined} aria-label={label}
              title={label} className="sidebar-nav-link">
              <Icon size={16} strokeWidth={1.7} aria-hidden /><span className="sidebar-label">{label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-tools">
          {client && <p className="sidebar-identity truncate text-xs text-muted-foreground" title={client}>{client}</p>}
          <ThemeButton sidebar />
          <Button variant="ghost" size="sm" className="sidebar-action" aria-label="Sign out" title="Sign out" onClick={() => void change('/logout')}>
            <DoorOpen aria-hidden /><span className="sidebar-label">Sign out</span>
          </Button>
        </div>
      </aside>
      <main className="flex min-w-0 flex-col px-4 pt-5 pb-9 sm:px-6 lg:pt-7">
        <h1 className="mb-5 text-2xl leading-tight font-semibold tracking-tight">{page.label}</h1>
        {(actionError || loadError) && <p role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-card px-4 py-3 text-destructive">{actionError || loadError}</p>}
        {content()}
      </main>
      {preview && <Viewer key={`${preview.view}:${preview.id}`} preview={preview} ended={isPreviewEnded(preview, data)} close={closePreview} change={mutate} />}
    </div>
  );
}

const root = document.getElementById('app');
if (!root) throw new Error('The dashboard mount is missing.');
const mode = root.dataset.page;
createRoot(root).render(mode === 'workspace' ? <Workspace /> : <SignIn method={mode === 'github' ? 'github' : 'password'} />);
