import { ArrowRight, ArrowUpRight, Clapperboard, Layers, Monitor, Pencil, Play, Plus, Workflow } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { MAX_PROFILE_NOTE_LENGTH } from '../src/profiles/note-limits.ts';
import { api, errorMessage, segment, type State } from './api.ts';
import { BrowserTile, type Preview } from './preview.tsx';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog.tsx';
import { Button } from './ui/button.tsx';
import { Card } from './ui/card.tsx';
import { Input } from './ui/input.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.tsx';
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
      canTakeover: Boolean(session.canTakeover),
      takeover: Boolean(session.takeover),
      description: [session.purpose === 'sign_in' ? 'Profile sign-in' : session.source, session.provider, session.client].filter(Boolean).join(' · '),
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
              <TableCell>{[session.profile, session.provider].filter(Boolean).join(' · ') || '—'}</TableCell>
              <TableCell>{session.client}</TableCell>
              <TableCell className="text-muted-foreground">{time(session.createdAt)}</TableCell>
              <TableCell>
                <Status tone={session.takeover || session.state === 'ready' ? 'good' : 'neutral'}>
                  {session.takeover ? 'In control' : session.state}
                </Status>
              </TableCell>
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
            <div className="text-xs text-muted-foreground">
              {[recording.purpose === 'check' ? 'Check' : recording.source, recording.profile, recording.provider].filter(Boolean).join(' · ')}
            </div>
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

function providerCapacity(provider: State['providers'][number]): string {
  if (provider.capacity) {
    const { used, total, queued } = provider.capacity;
    const usage = `${used} / ${total} in use`;
    return queued && queued > 0 ? `${usage} · ${queued} queued` : usage;
  }
  if (provider.sources?.includes('existing')) return 'Live attach';
  return '—';
}

export function Providers({ rows }: { rows: State['providers'] }) {
  if (!rows.length) return <EmptyMessage fill>No providers configured.</EmptyMessage>;
  return (
    <DataTable label="Providers" columns={['Provider', 'Status', 'Capacity', 'Last checked', 'Leased browsers']} compact>
      {rows.map((provider) => (
        <TableRow key={provider.name}>
          <TableCell>
            <span className="font-medium">{provider.name}</span>
            {provider.description && <p className="mt-1 whitespace-normal text-muted-foreground [overflow-wrap:anywhere]">{provider.description}</p>}
          </TableCell>
          <TableCell>
            {provider.builtIn
              ? <Status tone="neutral">Built-in</Status>
              : <Status tone={provider.reachable ? 'good' : 'bad'}>{provider.reachable ? 'Reachable' : provider.error ?? 'Unavailable'}</Status>}
          </TableCell>
          <TableCell className={provider.capacity ? undefined : 'text-muted-foreground'}>{providerCapacity(provider)}</TableCell>
          <TableCell className="text-muted-foreground">{time(provider.checkedAt)}</TableCell>
          <TableCell className={provider.builtIn || provider.sources?.includes('existing') ? 'text-muted-foreground' : undefined}>
            {provider.builtIn || provider.sources?.includes('existing')
              ? '—'
              : provider.slots.map((slot) => `Slot ${slot.slot}: ${slot.own ? 'This server' : slot.owner}`).join(', ') || 'None'}
          </TableCell>
        </TableRow>
      ))}
    </DataTable>
  );
}

const PROFILE_TABS = [['revisions', 'Revisions'], ['notes', 'Notes'], ['checks', 'Sign-in checks']] as const;
const PROFILE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

function ProfilePanel({ profile, signInState, tasks, change, open }: {
  profile: State['profiles'][number]; signInState?: string; tasks: State['tasks']; change: Change; open: (preview: Preview) => void;
}) {
  const path = `/profiles/${segment(profile.name)}`;
  const id = useId();
  const [tab, setTab] = useState<(typeof PROFILE_TABS)[number][0]>('revisions');
  const [opening, setOpening] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(profile.name);
  const [renamingBusy, setRenamingBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const renameInput = useRef<HTMLInputElement>(null);
  const skipBlurCommit = useRef(false);

  useEffect(() => {
    setDraftName(profile.name);
  }, [profile.name]);

  useEffect(() => {
    if (!renaming) return;
    renameInput.current?.focus();
    renameInput.current?.select();
  }, [renaming]);

  function startRename() {
    skipBlurCommit.current = false;
    setDraftName(profile.name);
    setRenaming(true);
  }

  function cancelRename() {
    skipBlurCommit.current = true;
    setDraftName(profile.name);
    setRenaming(false);
  }

  async function saveRename(nextName: string) {
    if (renamingBusy) return;
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === profile.name || !PROFILE_NAME_PATTERN.test(trimmed)) {
      setDraftName(profile.name);
      setRenaming(false);
      return;
    }
    setRenamingBusy(true);
    try {
      await change(`${path}/rename`, { name: trimmed });
      setRenaming(false);
    } finally {
      setRenamingBusy(false);
    }
  }

  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    skipBlurCommit.current = true;
    await saveRename(draftName);
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      if (await change(`${path}/delete`)) setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  async function connect() {
    setOpening(true);
    try {
      const result = await change<{ session: string }>(`${path}/sign-in`);
      if (result) {
        open({
          id: result.session,
          sessionId: result.session,
          title: `Sign in to ${profile.name}`,
          ...(profile.provider && profile.provider !== 'managed' && { description: profile.provider }),
          view: 'vnc',
        });
      }
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
        <div className="group/rename flex min-w-0 items-center gap-1.5">
          {renaming ? (
            <form className="flex min-w-0 items-center" onSubmit={(event) => void submitRename(event)}>
              <Input
                ref={renameInput}
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelRename();
                  }
                }}
                onBlur={() => {
                  if (skipBlurCommit.current) {
                    skipBlurCommit.current = false;
                    return;
                  }
                  void saveRename(draftName);
                }}
                aria-label={`Profile name for ${profile.name}`}
                pattern={String.raw`[a-z][a-z0-9\-]{0,62}`}
                title="Lowercase letters, digits, and hyphens"
                disabled={renamingBusy}
                required
                className="h-6 w-40 px-2 py-0 font-semibold sm:w-48"
              />
            </form>
          ) : (
            <>
              <h2 onClick={startRename} className="min-w-0 cursor-pointer text-sm font-semibold">
                <span className="break-anywhere">{profile.name}</span>
              </h2>
              <button
                type="button"
                aria-label={`Rename profile ${profile.name}`}
                title={`Rename profile ${profile.name}`}
                onClick={startRename}
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/rename:opacity-100 [@media(hover:none)]:opacity-60"
              >
                <Pencil size={12} aria-hidden />
              </button>
            </>
          )}
          {signInState === 'saving' ? <Status tone="neutral">Saving…</Status> : profile.inUse && <Status tone="good">In use</Status>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="xs" disabled={opening} onClick={() => void connect()}>{opening ? 'Connecting…' : 'Connect'}</Button>
          <Button size="xs" variant="ghost" disabled={deleting} onClick={() => setConfirmDelete(true)}>Delete</Button>
        </div>
      </div>
      <AlertDialog open={confirmDelete} onOpenChange={(next) => { if (!deleting) setConfirmDelete(next); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete profile {profile.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {profile.inUse
                ? `Active sessions using ${profile.name} will be closed immediately. All saved revisions, notes, and sign-in checks for this profile will be permanently deleted.`
                : `All saved revisions, notes, and sign-in checks for ${profile.name} will be permanently deleted.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={deleting} onClick={() => void handleDelete()}>
              {deleting ? 'Deleting…' : 'Delete profile'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
        className="scrollbar-compact min-h-0 flex-1 overflow-y-auto">
        <ProfileNotes profile={profile} path={path} change={change} />
      </div>
      <div role="tabpanel" id={`${id}-checks`} aria-labelledby={`${id}-checks-tab`} hidden={tab !== 'checks'} tabIndex={0}
        className={tab === 'checks' ? 'scrollbar-compact flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto *:shrink-0' : undefined}>
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
  const [confirmClear, setConfirmClear] = useState<{ slot: 'operator' | 'agent'; id: string }>();
  const operatorNote = profile.notes?.operator;
  const editing = !operatorNote || draft !== undefined;
  const noteText = draft ?? '';
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
    setBusy(true);
    try {
      if (await change(`${path}/notes/${segment(id)}/delete`)) {
        if (slot === 'operator') setDraft(undefined);
        setConfirmClear(undefined);
      }
    } finally {
      setBusy(false);
    }
  }
  return <>
    <div className="grid gap-2 md:h-full md:min-h-28 md:grid-cols-2 md:grid-rows-1">
      {(['operator', 'agent'] as const).map((slot) => {
        const note = profile.notes?.[slot];
        const label = slot === 'operator' ? 'Operator' : 'Agent';
        return <section key={slot} className="flex min-h-0 min-w-0 flex-col gap-1 rounded-lg border p-2" aria-label={`${label} note`}>
          <div className="flex min-h-6 shrink-0 items-center justify-between gap-2">
            <div className="min-w-0 break-anywhere text-xs leading-tight">
              <h3 className="font-medium">{label}</h3>
              {note && <p className="text-muted-foreground">{note.client} · <time dateTime={note.updatedAt}>{time(note.updatedAt)}</time></p>}
            </div>
            {note && <div className="flex shrink-0 items-center gap-1">
              {slot === 'operator' && <Button type="button" variant="ghost" size="xs" disabled={busy}
                onClick={() => setDraft(editing ? undefined : note.text)}>{editing ? 'Cancel' : 'Edit'}</Button>}
              {(slot === 'agent' || !editing) && <Button type="button" variant="ghost" size="xs" disabled={busy}
                onClick={() => setConfirmClear({ slot, id: note.id })}>Clear note</Button>}
            </div>}
          </div>
          {slot === 'operator' && editing ? <form className="flex min-h-0 flex-1 flex-col gap-2" onSubmit={(event) => void save(event)}>
            <textarea aria-label="Operator note text" aria-describedby={counterId} placeholder="Add context for people and agents (no secrets)" rows={2}
              className="scrollbar-compact min-h-14 w-full flex-1 resize-none rounded-md border border-input bg-background px-2 py-1 text-sm md:min-h-0" value={noteText}
              onChange={(event) => edit(event.target.value)} autoFocus={!!note} disabled={busy} required />
            <div className="flex shrink-0 items-center justify-end gap-2">
              <span id={counterId} className="w-[8ch] shrink-0 text-right font-mono text-xs whitespace-nowrap text-muted-foreground">
                {`${length}/${MAX_PROFILE_NOTE_LENGTH}`}
              </span>
              <Button type="submit" variant="outline" size="xs"
                disabled={busy || length > MAX_PROFILE_NOTE_LENGTH || !noteText.trim() || noteText === note?.text}>Save note</Button>
            </div>
          </form> : note
            ? <p tabIndex={0} className="scrollbar-compact mt-1 break-anywhere text-sm whitespace-pre-wrap md:min-h-0 md:overflow-y-auto md:text-xs">{note.text}</p>
            : <p className="text-sm text-muted-foreground md:text-xs">No agent note.</p>}
        </section>;
      })}
    </div>
    <AlertDialog open={confirmClear !== undefined} onOpenChange={(next) => { if (!busy && !next) setConfirmClear(undefined); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear {confirmClear?.slot} note?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the {confirmClear?.slot} note from profile {profile.name}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={() => confirmClear && void clear(confirmClear.slot, confirmClear.id)}>
            {busy ? 'Clearing…' : 'Clear note'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

export function Profiles({ state, change, open }: { state: State; change: Change; open: (preview: Preview) => void }) {
  const [provider, selectProvider] = useState('managed');
  const [profileName, setProfileName] = useState('');
  const [busy, setBusy] = useState(false);
  const configured = state.providers.filter((entry) => entry.managedRuntime !== null);
  const configuredNames = new Set(configured.map((entry) => entry.name));
  const extraProviders = [...new Set(state.profiles.map((entry) => entry.provider ?? 'managed'))]
    .filter((name) => name !== 'managed' && !configuredNames.has(name))
    .sort();
  const selected = configured.find((entry) => entry.name === provider);
  const managed = provider === 'managed';
  const ready = managed || selected?.managedRuntime === 'ready';
  const visible = state.profiles.filter((entry) => (entry.provider ?? 'managed') === provider);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    try {
      const payload = managed ? { name: profileName } : { name: profileName, provider };
      if (await change('/profiles', payload)) setProfileName('');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-1 flex-col gap-4">
      <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => void create(event)}>
        <Input name="name" value={profileName} onChange={(event) => setProfileName(event.target.value)}
          aria-label="Profile name" placeholder="Profile name" className="w-full sm:w-56"
          pattern={String.raw`[a-z][a-z0-9\-]{0,62}`} title="Lowercase letters, digits, and hyphens" required />
        {(configured.length > 0 || extraProviders.length > 0 || !managed) &&
          <Select value={provider} onValueChange={selectProvider} disabled={busy}>
            <SelectTrigger aria-label="Provider" className="w-32 max-w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="managed">Managed</SelectItem>
              {configured.map(({ name }) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
              {extraProviders.map((name) => <SelectItem key={name} value={name}>{name} (unconfigured)</SelectItem>)}
              {!managed && !selected && !extraProviders.includes(provider) && (
                <SelectItem value={provider} disabled>{provider} (unavailable)</SelectItem>
              )}
            </SelectContent>
          </Select>}
        <Button type="submit" disabled={busy || !ready}><Plus aria-hidden /> Create profile</Button>
      </form>
      {!managed && selected?.managedRuntime === 'unavailable' && (
        <p role="status" className="text-xs text-muted-foreground">Provider {provider} is currently unavailable.</p>
      )}
      {!managed && selected?.managedRuntime === 'incompatible' && (
        <p role="alert" className="text-xs text-destructive">Provider {provider} runtime is incompatible with this server.</p>
      )}
      {!managed && !selected && (
        <p role="status" className="text-xs text-muted-foreground">Provider {provider} is not configured on this server.</p>
      )}
      {visible.length
        ? visible.map((profile) => {
          const signInState = state.sessions.find((session) => session.purpose === 'sign_in' && session.profile === profile.name)?.state;
          return <ProfilePanel key={profile.name} profile={profile} signInState={signInState} tasks={state.tasks} change={change} open={open} />;
        })
        : <EmptyMessage fill>No profiles yet.</EmptyMessage>}
    </div>
  );
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
          <pre className="scrollbar-compact max-h-96 overflow-auto rounded-md bg-secondary p-4 text-xs">{source.content}</pre>
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
