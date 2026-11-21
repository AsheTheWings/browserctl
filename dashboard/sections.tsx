import { ArrowRight, ArrowUpRight, Clapperboard, Layers, Monitor, Play, Plus, Workflow } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { MAX_PROFILE_NOTE_LENGTH } from '../src/profiles/note-limits.ts';
import type { ProviderProfile } from '../src/providers/lease-client.ts';
import { api, errorMessage, segment, type State } from './api.ts';
import { BrowserTile, type Preview } from './preview.tsx';
import { Button } from './ui/button.tsx';
import { Card } from './ui/card.tsx';
import { Input } from './ui/input.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx';
import { cn } from './ui/utils.ts';

type Change = <T = unknown>(path: string, data?: unknown) => Promise<T | undefined>;

const time = (iso?: string | null) => iso
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
  : '—';
const size = (bytes: number) => bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;

function Status({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'good' | 'bad' | 'neutral' }) {
  return <span className="status" data-tone={tone}>{children}</span>;
}

function Section({ title, icon: Icon, action, children }: {
  title: string; icon?: typeof Monitor; action?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-2 flex min-h-7 flex-wrap items-center justify-between gap-1">
        <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
          {Icon && <Icon size={15} className="text-muted-foreground" aria-hidden />}{title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Empty({ icon: Icon, children }: { icon: typeof Monitor; children: ReactNode }) {
  return (
    <Card className="panel flex min-h-16 flex-row items-center gap-3 px-4 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground"><Icon size={15} aria-hidden /></span>
      <p className="text-muted-foreground">{children}</p>
    </Card>
  );
}

function EmptyMessage({ fill, children }: { fill?: boolean; children: ReactNode }) {
  return <p className={`grid place-items-center text-center text-muted-foreground ${fill ? 'flex-1' : 'min-h-32'}`}>{children}</p>;
}

function DataTable({ label, columns, children, compact }: {
  label: string; columns: (string | null)[]; children: ReactNode; compact?: boolean;
}) {
  return (
    <div className={`panel data-table overflow-hidden border bg-card ${compact ? 'data-table-compact rounded-lg' : 'rounded-xl'}`}>
      <Table aria-label={label} className={compact ? 'text-[.75rem]' : undefined}>
        <TableHeader>
          <TableRow>{columns.map((column, index) => <TableHead key={index} scope="col">{column ?? <span className="sr-only">Actions</span>}</TableHead>)}</TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}

export function Overview({ state, open }: { state: State; open: (preview: Preview) => void }) {
  const browsers = [
    ...state.sessions.flatMap((session) => session.state !== 'ready' || session.view === 'none' ? [] : [{
      id: session.id,
      sessionId: session.id,
      title: session.purpose === 'sign_in' ? `Sign in to ${session.profile ?? session.id}` : session.profile ?? session.provider ?? session.id,
      view: session.view,
      description: `${session.purpose === 'sign_in' ? 'Profile sign-in' : session.source} · ${session.client}`,
    }]),
    ...state.watched.map((entry) => ({
      id: entry.id, title: `${entry.provider} · Slot ${entry.slot}`, view: 'screencast' as const,
      description: `Watching · ${entry.owner}`,
    })),
  ];
  return (
    <div className="space-y-5">
      <Section title="Live browsers" icon={Monitor}>
        {browsers.length ? (
          <div className="grid max-w-sm grid-cols-1 gap-3 sm:max-w-none sm:grid-cols-3 xl:grid-cols-5">
            {browsers.map((preview) => (
              <BrowserTile key={preview.id} preview={preview} description={preview.description}
                open={(fullscreen) => open({ ...preview, fullscreen })} />
            ))}
          </div>
        ) : <EmptyMessage>No live browsers.</EmptyMessage>}
      </Section>
      <Section title="Sessions" icon={Layers}>
        {state.sessions.length || state.watched.length ? (
          <DataTable label="Sessions" columns={['Session', 'Source', 'Profile or provider', 'Client', 'Started', 'State']}>
            {state.sessions.map((session) => <TableRow key={session.id}>
              <TableCell className="font-medium">{session.id}</TableCell>
              <TableCell>{session.purpose === 'agent' ? session.source : session.purpose.replace('_', '-')}</TableCell>
              <TableCell>{session.profile ?? session.provider ?? '—'}</TableCell>
              <TableCell>{session.client}</TableCell>
              <TableCell className="text-muted-foreground">{time(session.createdAt)}</TableCell>
              <TableCell><Status tone={session.state === 'ready' ? 'good' : 'neutral'}>{session.state}</Status></TableCell>
            </TableRow>)}
            {state.watched.map((entry) => <TableRow key={entry.id}>
              <TableCell className="font-medium">{entry.id}</TableCell><TableCell>Watched</TableCell>
              <TableCell>{entry.provider} · Slot {entry.slot}</TableCell><TableCell>{entry.owner}</TableCell>
              <TableCell>—</TableCell><TableCell><Status tone={entry.running ? 'good' : 'neutral'}>{entry.running ? 'Running' : 'Idle'}</Status></TableCell>
            </TableRow>)}
          </DataTable>
        ) : <EmptyMessage>No active sessions.</EmptyMessage>}
      </Section>
      <Section title="Recent recordings" icon={Clapperboard} action={
        <Button asChild variant="ghost" size="sm"><a href="#recordings">All recordings <ArrowRight aria-hidden /></a></Button>
      }>
        <Recordings rows={state.recordings} limit={5} open={open} />
      </Section>
    </div>
  );
}

export function Recordings({ rows, limit, open }: { rows: State['recordings']; limit?: number; open: (preview: Preview) => void }) {
  const finished = rows.filter((recording) => !recording.active).slice(0, limit);
  if (!finished.length) return <Empty icon={Clapperboard}>No recordings yet.</Empty>;
  return (
    <DataTable label="Recordings" columns={['Session', 'Client', 'Started', 'Ended', 'Size', null]}>
      {finished.map((recording) => (
        <TableRow key={recording.session}>
          <TableCell>
            <div className="font-medium">{recording.session}</div>
            <div className="text-xs text-muted-foreground">{recording.purpose === 'check' ? 'Check' : recording.source}{recording.profile ?? recording.provider ? ` · ${recording.profile ?? recording.provider}` : ''}</div>
            <div className="mt-0.5 text-xs text-muted-foreground sm:hidden">{time(recording.startedAt)}</div>
          </TableCell>
          <TableCell>{recording.client}</TableCell>
          <TableCell>{time(recording.startedAt)}</TableCell>
          <TableCell>{time(recording.endedAt)}</TableCell>
          <TableCell className="text-muted-foreground">{size(recording.bytes)}</TableCell>
          <TableCell className="text-right">
            <Button variant="outline" size="xs" onClick={() => open({ id: recording.session, title: recording.session, view: 'recording' })}><Play aria-hidden /> Play</Button>
          </TableCell>
        </TableRow>
      ))}
    </DataTable>
  );
}

export function Providers({ rows }: { rows: State['providers'] }) {
  if (!rows.length) return <EmptyMessage fill>No providers configured.</EmptyMessage>;
  return (
    <DataTable label="Providers" columns={['Provider', 'Connection', 'Last checked', 'Leased browsers']} compact>
      {rows.map((provider) => (
        <TableRow key={provider.name}>
          <TableCell className="font-medium">{provider.name}</TableCell>
          <TableCell><Status tone={provider.reachable ? 'good' : 'bad'}>{provider.reachable ? 'Reachable' : provider.error ?? 'Unavailable'}</Status></TableCell>
          <TableCell className="text-muted-foreground">{time(provider.checkedAt)}</TableCell>
          <TableCell>{provider.slots.map((slot) => `Slot ${slot.slot}: ${slot.own ? 'This server' : slot.owner}`).join(', ') || 'None'}</TableCell>
        </TableRow>
      ))}
    </DataTable>
  );
}

const PROFILE_TABS = [['revisions', 'Revisions'], ['notes', 'Notes'], ['checks', 'Sign-in checks']] as const;

function ProfilePanel({ profile, tasks, change, open }: {
  profile: State['profiles'][number]; tasks: State['tasks']; change: Change; open: (preview: Preview) => void;
}) {
  const path = `/profiles/${segment(profile.name)}`;
  const id = useId();
  const [tab, setTab] = useState<(typeof PROFILE_TABS)[number][0]>('revisions');
  const [opening, setOpening] = useState(false);
  async function connect() {
    setOpening(true);
    try {
      const result = await change<{ session: string }>(`${path}/sign-in`);
      if (result) open({ id: result.session, sessionId: result.session, title: `Sign in to ${profile.name}`, view: 'vnc' });
    } finally {
      setOpening(false);
    }
  }
  async function addService(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (await change(`${path}/services`, { name: data.get('name'), task: data.get('task') })) form.reset();
  }

  return (
    <Card className={cn('panel min-h-56 shrink-0 gap-2 rounded-lg px-3 py-2 sm:px-4 md:gap-3 md:py-3', tab !== 'revisions' && 'h-56')}>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold"><span className="break-anywhere">{profile.name}</span>{profile.inUse && <Status tone="good">In use</Status>}</h2>
        <div className="flex flex-wrap gap-2">
          <Button size="xs" disabled={opening} onClick={() => void connect()}>{opening ? 'Connecting…' : 'Connect'}</Button>
          <Button size="xs" variant="ghost" disabled={profile.inUse} onClick={() => {
            if (confirm(`Delete profile ${profile.name}?`)) void change(`${path}/delete`);
          }}>Delete</Button>
        </div>
      </div>
      <div role="tablist" aria-label={`${profile.name} details`} className="flex shrink-0 flex-wrap gap-1"
        onKeyDown={(event) => {
          const index = PROFILE_TABS.findIndex(([value]) => value === tab);
          const last = PROFILE_TABS.length - 1;
          const next = event.key === 'ArrowRight' ? (index + 1) % PROFILE_TABS.length
            : event.key === 'ArrowLeft' ? (index + last) % PROFILE_TABS.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? last : undefined;
          if (next === undefined) return;
          event.preventDefault();
          const value = PROFILE_TABS[next]![0];
          setTab(value);
          document.getElementById(`${id}-${value}-tab`)?.focus();
        }}>
        {PROFILE_TABS.map(([value, label]) => <Button key={value} id={`${id}-${value}-tab`} type="button" role="tab"
          size="xs" variant={tab === value ? 'secondary' : 'ghost'} tabIndex={tab === value ? 0 : -1}
          aria-selected={tab === value} aria-controls={`${id}-${value}`} onClick={() => setTab(value)}>{label}</Button>)}
      </div>
      <div role="tabpanel" id={`${id}-revisions`} aria-labelledby={`${id}-revisions-tab`} hidden={tab !== 'revisions'} tabIndex={0}>
        <DataTable label={`${profile.name} revisions`} columns={['Revision', 'Created', 'Client', null]} compact>
          {[...profile.revisions].reverse().map((revision) => <TableRow key={revision.id}>
            <TableCell>{revision.id}{revision.id === profile.current && ' · Current'}{revision.pinned && ' · Pinned'}</TableCell>
            <TableCell>{time(revision.createdAt)}</TableCell><TableCell>{revision.client}</TableCell>
            <TableCell className="space-x-1 text-right">
              <Button variant="ghost" size="xs" onClick={() => void change(`${path}/revisions/${segment(revision.id)}/pin`, { pinned: !revision.pinned })}>{revision.pinned ? 'Unpin' : 'Pin'}</Button>
              {revision.id !== profile.current && <Button variant="outline" size="xs" onClick={() => void change(`${path}/current`, { revision: revision.id })}>Make current</Button>}
            </TableCell>
          </TableRow>)}
        </DataTable>
      </div>
      <div role="tabpanel" id={`${id}-notes`} aria-labelledby={`${id}-notes-tab`} hidden={tab !== 'notes'} tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto">
        <ProfileNotes profile={profile} path={path} change={change} />
      </div>
      <div role="tabpanel" id={`${id}-checks`} aria-labelledby={`${id}-checks-tab`} hidden={tab !== 'checks'} tabIndex={0}
        className={tab === 'checks' ? 'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto *:shrink-0' : undefined}>
        {profile.services.length > 0 && <DataTable label={`${profile.name} sign-in checks`} columns={['Service', 'Check task', 'Last check', null]} compact>
          {profile.services.map((service) => {
            const url = `${path}/services/${segment(service.name)}`;
            return <TableRow key={service.name}>
              <TableCell>{service.name}</TableCell><TableCell>{service.task}</TableCell>
              <TableCell>{service.lastCheck
                ? <><Status tone={service.lastCheck.result === 'signed_in' ? 'good' : 'bad'}>{service.lastCheck.result.replace('_', ' ')}</Status><span className="ml-2 text-xs text-muted-foreground">{time(service.lastCheck.time)} · Run {service.lastCheck.run}</span></>
                : 'Not checked'}</TableCell>
              <TableCell className="space-x-1 text-right">
                <Button variant="outline" size="xs" onClick={() => void change(`${url}/check`)}>Check now</Button>
                <Button variant="ghost" size="xs" onClick={() => void change(`${url}/delete`)}>Remove</Button>
              </TableCell>
            </TableRow>;
          })}
        </DataTable>}
        {tasks.length > 0 ? <form className="flex flex-wrap gap-2" onSubmit={(event) => void addService(event)}>
          <Input name="name" aria-label="Service name" placeholder="Service name" required className="w-44" />
          <select name="task" aria-label="Check task">{tasks.map((task) => <option key={task.name}>{task.name}</option>)}</select>
          <Button type="submit" variant="outline"><Plus aria-hidden /> Add service</Button>
        </form> : <p className="grid flex-1 place-items-center text-center text-xs text-muted-foreground">A saved check task is required to add a service.</p>}
      </div>
    </Card>
  );
}

function ProfileNotes({ profile, path, change }: { profile: State['profiles'][number]; path: string; change: Change }) {
  const counterId = useId();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string>();
  const noteText = draft ?? profile.notes?.operator?.text ?? '';
  const length = [...noteText].length;
  function edit(text: string) {
    const nextLength = [...text].length;
    // A saved note above the limit can be shortened without losing its contents on load.
    if (nextLength <= MAX_PROFILE_NOTE_LENGTH || nextLength < length) setDraft(text);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      if (await change(`${path}/notes`, { text: noteText })) setDraft(undefined);
    } finally {
      setBusy(false);
    }
  }
  async function clear(slot: 'operator' | 'agent', id: string) {
    if (!confirm(`Clear the ${slot} note?`)) return;
    setBusy(true);
    try {
      if (await change(`${path}/notes/${segment(id)}/delete`) && slot === 'operator') setDraft(undefined);
    } finally {
      setBusy(false);
    }
  }
  return <div className="grid gap-2 md:h-full md:min-h-28 md:grid-cols-2 md:grid-rows-1">
    {(['operator', 'agent'] as const).map((slot) => {
      const note = profile.notes?.[slot];
      const label = slot === 'operator' ? 'Operator' : 'Agent';
      return <section key={slot} className="flex min-h-0 min-w-0 flex-col gap-1 rounded-lg border p-2" aria-label={`${label} note`}>
        <div className="flex min-h-6 shrink-0 items-center justify-between gap-2">
          <div className="min-w-0 break-anywhere text-xs leading-tight">
            <h3 className="font-medium">{label}</h3>
            {note && <p className="text-muted-foreground">{note.client} · <time dateTime={note.updatedAt}>{time(note.updatedAt)}</time></p>}
          </div>
          {note && <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => void clear(slot, note.id)}>Clear note</Button>}
        </div>
        {slot === 'operator' ? <form className="flex min-h-0 flex-1 flex-col gap-2" onSubmit={(event) => void save(event)}>
          <textarea aria-label="Operator note text" aria-describedby={counterId} placeholder="Add context for people and agents (no secrets)" rows={2}
            className="min-h-14 w-full flex-1 resize-none rounded-md border border-input bg-background px-2 py-1 text-[1rem] md:min-h-0 md:text-base" value={noteText}
            onChange={(event) => edit(event.target.value)} disabled={busy} required />
          <div className="flex shrink-0 items-center justify-end gap-2">
            <span id={counterId} className="w-[8ch] shrink-0 text-right font-mono text-xs whitespace-nowrap text-muted-foreground">
              {`${length}/${MAX_PROFILE_NOTE_LENGTH}`}
            </span>
            <Button type="submit" variant="outline" size="xs"
              disabled={busy || length > MAX_PROFILE_NOTE_LENGTH || !noteText.trim() || noteText === note?.text}>Save note</Button>
          </div>
        </form> : note
          ? <p tabIndex={0} className="break-anywhere text-sm whitespace-pre-wrap md:min-h-0 md:overflow-y-auto md:text-xs">{note.text}</p>
          : <p className="text-sm text-muted-foreground md:text-xs">No agent note.</p>}
      </section>;
    })}
  </div>;
}

export function Profiles({ state, change, open }: { state: State; change: Change; open: (preview: Preview) => void }) {
  const [provider, selectProvider] = useState('managed');
  const capable = state.providers.filter((entry) => entry.profileManagement);
  const selected = state.providers.find((entry) => entry.name === provider);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (await change('/profiles', { name: new FormData(form).get('name') })) form.reset();
  }
  return (
    <div className="flex flex-1 flex-col gap-4">
      {(capable.length > 0 || selected) && <label className="flex w-fit items-center gap-2 text-sm">
        Provider
        <select aria-label="Profile provider" value={provider} onChange={(event) => selectProvider(event.target.value)}>
          <option value="managed">Managed</option>
          {capable.map(({ name }) => <option key={name} value={name}>{name}</option>)}
          {selected && !selected.profileManagement && <option value={selected.name}>{selected.name} (unavailable)</option>}
        </select>
      </label>}
      {selected ? (
        selected.profileManagement ? <ProviderProfiles key={selected.name} provider={selected.name} change={change} open={open} />
          : <EmptyMessage>The selected provider is unavailable.</EmptyMessage>
      ) : <>
      <form className="flex flex-wrap gap-2" onSubmit={(event) => void create(event)}>
        <Input name="name" aria-label="Profile name" placeholder="Profile name" className="w-56" pattern={String.raw`[a-z][a-z0-9\-]{0,62}`} title="Lowercase letters, digits, and hyphens" required />
        <Button type="submit"><Plus aria-hidden /> Create profile</Button>
      </form>
      {state.profiles.length
        ? state.profiles.map((profile) => <ProfilePanel key={profile.name} profile={profile} tasks={state.tasks} change={change} open={open} />)
        : <EmptyMessage fill>No profiles yet.</EmptyMessage>}
      </>}
    </div>
  );
}

function ProviderProfiles({ provider, change, open }: { provider: string; change: Change; open: (preview: Preview) => void }) {
  const path = `/provider-profiles/${segment(provider)}`;
  const [profiles, setProfiles] = useState<ProviderProfile[]>();
  const [failure, setFailure] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ profiles: ProviderProfile[] }>(path, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) {
        setProfiles(result.profiles);
        setFailure(undefined);
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setFailure(errorMessage(error));
    });
    return () => controller.abort();
  }, [path, refresh]);

  async function mutate<T>(suffix: string, data: unknown, apply: (result: T) => void) {
    setBusy(true);
    try {
      const result = await change<T>(`${path}${suffix}`, data);
      if (result) apply(result);
    } finally { setBusy(false); }
  }
  function update(profile: ProviderProfile) {
    setProfiles((before) => [...(before ?? []).filter(({ name }) => name !== profile.name), profile]
      .sort((a, b) => a.name.localeCompare(b.name)));
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    await mutate<ProviderProfile>('', { name: new FormData(form).get('name') }, (profile) => {
      update(profile);
      form.reset();
    });
  }
  return <>
    <form className="flex flex-wrap gap-2" onSubmit={(event) => void create(event)}>
      <Input name="name" aria-label="Profile name" placeholder="Profile name" className="w-56" pattern={String.raw`[a-z][a-z0-9\-]{0,62}`} required />
      <Button type="submit" disabled={busy || !profiles || !!failure}><Plus aria-hidden /> Create profile</Button>
    </form>
    {failure ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
      {failure}<Button size="xs" variant="outline" onClick={() => setRefresh((value) => value + 1)}>Refresh</Button>
    </div> : !profiles ? <EmptyMessage>Loading profiles…</EmptyMessage> : profiles.length === 0 ? <EmptyMessage>No profiles yet.</EmptyMessage>
      : profiles.map(({ name, current, revisions }) => <Card key={name} className="panel min-h-56 gap-3 rounded-lg px-3 py-3 sm:px-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="break-anywhere text-sm font-semibold">{name}</h2>
          <div className="flex flex-wrap gap-2">
            <Button size="xs" disabled={busy} onClick={() => void mutate<{ edit: string }>('/edit', { name }, ({ edit }) => open({
              id: edit, title: `Connect to ${name}`, description: provider, view: 'profile-edit',
              onFinished: () => setRefresh((value) => value + 1),
            }))}>Connect</Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => {
              if (confirm(`Delete profile ${name} on ${provider}?`)) {
                void mutate('/delete', { name }, () => setProfiles((before) => before?.filter((entry) => entry.name !== name)));
              }
            }}>Delete</Button>
          </div>
        </div>
        {revisions.length === 0 ? <EmptyMessage fill>No saved revisions.</EmptyMessage>
          : <DataTable label={`${name} revisions`} columns={['Revision', 'Created', 'Client', null]} compact>
            {revisions.map((revision) => <TableRow key={revision.id}>
              <TableCell><span title={revision.id}>{revision.id.slice(0, 8)}</span>{revision.id === current && ' · Current'}{revision.pinned && ' · Pinned'}</TableCell>
              <TableCell>{time(revision.createdAt)}</TableCell>
              <TableCell>{revision.client}</TableCell>
              <TableCell className="space-x-1 text-right">
                <Button variant="ghost" size="xs" disabled={busy} onClick={() => void mutate<ProviderProfile>('/pin',
                  { name, revision: revision.id, pinned: !revision.pinned }, update)}>{revision.pinned ? 'Unpin' : 'Pin'}</Button>
                {revision.id !== current && <Button variant="outline" size="xs" disabled={busy} onClick={() => void mutate<ProviderProfile>('/current',
                  { name, revision: revision.id }, update)}>Make current</Button>}
              </TableCell>
            </TableRow>)}
          </DataTable>}
      </Card>)}
  </>;
}

export function Tasks({ state, report }: { state: State; report: (message: string) => void }) {
  const [source, setSource] = useState<{ label: string; content: string }>();
  async function showSource(name: string, revision: string) {
    try {
      const result = await api<{ content: string; client: string }>(`/tasks/${segment(name)}/revisions/${segment(revision)}`);
      setSource({ label: `${name} · Revision ${revision} · ${result.client}`, content: result.content });
    } catch (error) {
      report(errorMessage(error));
    }
  }
  return (
    <div className="space-y-5">
      <section aria-label="Saved tasks">
        {state.tasks.length ? <DataTable label="Saved tasks" columns={['Task', 'Revisions']}>
          {state.tasks.map((task) => <TableRow key={task.name}>
            <TableCell className="font-medium">{task.name}</TableCell>
            <TableCell className="wrap">
              <div className="flex flex-wrap gap-1.5">
                {[...task.revisions].reverse().map((revision) =>
                  <Button key={revision.id} title={`${time(revision.createdAt)} by ${revision.client}`} size="sm" variant="outline" onClick={() => void showSource(task.name, revision.id)}>r{revision.id} · {revision.client}<ArrowUpRight aria-hidden /></Button>)}
              </div>
            </TableCell>
          </TableRow>)}
        </DataTable> : <Empty icon={Workflow}>No saved tasks.</Empty>}
        {source && <Card className="mt-3 gap-3 p-4">
          <div className="flex items-center justify-between gap-2"><h2 className="font-medium">{source.label}</h2><Button variant="ghost" size="sm" onClick={() => setSource(undefined)}>Close source</Button></div>
          <pre className="max-h-96 overflow-auto rounded-md bg-secondary p-4 text-xs">{source.content}</pre>
        </Card>}
      </section>
      <Section title="Recent runs">
        {state.runs.length ? <DataTable label="Recent runs" columns={['Run', 'Task', 'Status', 'Client', 'Started', 'Duration', 'Details']}>
          {state.runs.map((run) => <TableRow key={run.run}>
            <TableCell>{run.run}</TableCell><TableCell>{run.task} r{run.revision}</TableCell>
            <TableCell><Status tone={run.status === 'passed' ? 'good' : 'bad'}>{run.status.replaceAll('_', ' ')}</Status></TableCell>
            <TableCell>{run.client}</TableCell><TableCell>{time(run.startedAt)}</TableCell><TableCell>{(run.durationMs / 1000).toFixed(1)} s</TableCell>
            <TableCell><details><summary className="cursor-pointer text-primary">View</summary>
              {([['Input', run.input], ['Output', run.output], ['Failure', run.failure]] as const).map(([label, detail]) => detail === undefined ? null : <div key={label} className="mt-2"><span className="font-medium">{label}</span><pre className="run-value mt-1 text-xs">{detail}</pre></div>)}
            </details></TableCell>
          </TableRow>)}
        </DataTable> : <Empty icon={Workflow}>No recent runs.</Empty>}
      </Section>
    </div>
  );
}
