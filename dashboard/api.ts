import type { Profile } from '../src/profiles/store.ts';
import type { Recording } from '../src/recordings/store.ts';
import type { RunRecord } from '../src/tasks/runs.ts';
import type { TaskRevision } from '../src/tasks/store.ts';

export interface Session {
  id: string;
  purpose: string;
  source: string;
  profile?: string;
  revision?: string;
  provider?: string;
  client: string;
  createdAt: string;
  state: string;
  view: 'vnc' | 'window' | 'screencast' | 'none';
}

interface Watched {
  id: string;
  provider: string;
  slot: number;
  owner: string;
  running: boolean;
}

interface Provider {
  name: string;
  reachable: boolean;
  profileManagement: boolean;
  error: string | null;
  checkedAt: string | null;
  slots: { slot: number; owner: string; own: boolean; running: boolean }[];
}

export interface State {
  client: string;
  sessions: Session[];
  watched: Watched[];
  providers: Provider[];
  profiles: (Profile & { inUse: boolean })[];
  tasks: { name: string; revisions: TaskRevision[] }[];
  runs: RunRecord[];
  recordings: Recording[];
}

export const dashboard = '/dashboard/';
export const apiPath = `${dashboard}api`;
export const socketBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${dashboard}ws`;
export const segment = encodeURIComponent;

export function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiPath}${path}`, init);
  if (response.status === 401) location.replace(dashboard);
  if (response.status === 204) return undefined as T;
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status}).`);
  return result;
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Request failed.';
