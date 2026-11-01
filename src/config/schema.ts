// The input schema in config/inputs.json and the layering that turns process inputs into typed configuration.
// Layers apply lowest first: schema defaults, target overlay files, the protected file, process inputs.

import { isIP } from 'node:net';
import schemaJson from '../../config/inputs.json' with { type: 'json' };

export type Profile = 'development' | 'production';
export type Process = 'server' | 'admin';
export type InputClass = 'configuration' | 'protected';

export type Shape =
  | { type: 'enum'; values: string[] }
  | { type: 'string'; empty?: boolean }
  | { type: 'name' }
  | { type: 'path'; empty?: boolean }
  | { type: 'paths' }
  | { type: 'integer'; min: number; max: number }
  | { type: 'port' }
  | { type: 'ip' }
  | { type: 'url'; empty?: boolean }
  | { type: 'providers' };

export interface InputDefinition {
  name: string;
  shape: Shape;
  class: InputClass;
  source?: 'process';
  processes: Process[];
  defaults: Partial<Record<Profile, string>>;
  description: string;
}

export interface Schema {
  schema_version: number;
  profiles: Profile[];
  inputs: InputDefinition[];
}

export const schema = schemaJson as Schema;

/** A refusal naming inputs and files, never a value. */
export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid configuration:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
    this.problems = problems;
  }
}

/** Names a process must never receive unless the schema declares them, so no library reads an undeclared one. */
const RESERVED_PREFIXES = ['BROWSERCTL_', 'OTEL_'];
const XDG_NAMES = new Set(['XDG_STATE_HOME', 'XDG_CACHE_HOME']);
/** Inputs that only serve as bases of other defaults: resolved when a default refers to them or when they are set. */
const BASES = new Set(['HOME', ...XDG_NAMES]);
const LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;

export function definition(name: string): InputDefinition | undefined {
  return schema.inputs.find((input) => input.name === name);
}

/** Parse literal NAME=value lines; blank lines and lines starting with # are skipped. */
export function parseLines(text: string, file: string): Map<string, string> {
  const values = new Map<string, string>();
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;
    const match = LINE.exec(line);
    if (!match) throw new ConfigError([`${file}:${index + 1}: want NAME=value`]);
    const [, name, value] = match as unknown as [string, string, string];
    if (values.has(name)) throw new ConfigError([`${file}:${index + 1}: ${name} is set twice`]);
    values.set(name, value);
  });
  return values;
}

export interface LayerFile {
  text: string;
  /** Whether only the reading user can read and write the file. */
  ownerOnly: boolean;
}

/** Reads a layer file; undefined when it does not exist. Throws for any other failure. */
export type LayerReader = (path: string) => LayerFile | undefined;

export interface Resolved {
  profile: Profile;
  values: Map<string, string>;
}

/** Layer and validate the inputs one process reads; every problem is reported at once. */
export function resolve(process: Process, environment: Record<string, string | undefined>, read: LayerReader): Resolved {
  const problems: string[] = [];
  const env = new Map<string, string>();
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (XDG_NAMES.has(name) && value === '') continue;
    env.set(name, value);
  }
  for (const name of env.keys()) {
    if (RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix)) && !definition(name)) {
      problems.push(`${name}: not an input of browserctl`);
    }
  }

  const profileValue = env.get('BROWSERCTL_PROFILE') ?? 'development';
  if (profileValue !== 'development' && profileValue !== 'production') {
    throw new ConfigError([...problems, 'BROWSERCTL_PROFILE: want development or production']);
  }
  const profile: Profile = profileValue;
  const layered = new Map<string, string>();

  const applyFile = (path: string, kind: 'overlay' | 'protected') => {
    let file: LayerFile | undefined;
    try {
      file = read(path);
    } catch {
      problems.push(`${path}: unreadable`);
      return;
    }
    if (file === undefined) return;
    if (kind === 'protected' && !file.ownerOnly) {
      problems.push(`${path}: a protected file must be readable by its owner alone`);
      return;
    }
    let lines: Map<string, string>;
    try {
      lines = parseLines(file.text, path);
    } catch (error) {
      problems.push(...(error as ConfigError).problems);
      return;
    }
    for (const [name, value] of lines) {
      const input = definition(name);
      if (!input) problems.push(`${path}: ${name} is not an input of browserctl`);
      else if (input.source === 'process') problems.push(`${path}: ${name} is only a process input`);
      else if (kind === 'overlay' && input.class === 'protected') {
        problems.push(`${path}: ${name} is protected; set it in the protected file or the process`);
      } else if (kind === 'protected' && input.class !== 'protected') {
        problems.push(`${path}: ${name} is not protected; set it in an overlay`);
      } else layered.set(name, value);
    }
  };

  const overlays = env.get('BROWSERCTL_OVERLAY_FILES') ?? '';
  for (const path of overlays.split(':').filter((entry) => entry !== '')) {
    if (!path.startsWith('/')) problems.push('BROWSERCTL_OVERLAY_FILES: each file must be an absolute path');
    else applyFile(path, 'overlay');
  }
  const protectedFile = env.get('BROWSERCTL_PROTECTED_FILE') ?? '';
  if (protectedFile !== '') {
    if (!protectedFile.startsWith('/')) problems.push('BROWSERCTL_PROTECTED_FILE: must be an absolute path');
    else applyFile(protectedFile, 'protected');
  }
  for (const input of schema.inputs) {
    const value = env.get(input.name);
    if (value !== undefined) layered.set(input.name, value);
  }

  const values = new Map<string, string>();
  const resolving = new Set<string>();
  const valueOf = (name: string): string | undefined => {
    if (values.has(name)) return values.get(name);
    const input = definition(name);
    if (!input) return undefined;
    let value = layered.get(name);
    if (value === undefined) {
      const fallback = input.defaults[profile];
      if (fallback === undefined) {
        problems.push(`${name}: required in the ${profile} profile`);
        return undefined;
      }
      if (resolving.has(name)) {
        problems.push(`${name}: its default refers to itself`);
        return undefined;
      }
      resolving.add(name);
      let missing = false;
      value = fallback.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, reference: string) => {
        const resolved = valueOf(reference);
        if (resolved === undefined) missing = true;
        return resolved ?? '';
      });
      resolving.delete(name);
      if (missing) return undefined;
    }
    const problem = check(input.shape, value);
    if (problem) {
      problems.push(`${name}: ${problem}`);
      return undefined;
    }
    values.set(name, value);
    return value;
  };
  for (const input of schema.inputs) {
    if (input.processes.includes(process) && (!BASES.has(input.name) || layered.has(input.name))) valueOf(input.name);
  }
  if (problems.length > 0) throw new ConfigError([...new Set(problems)]);
  return { profile, values };
}

/** The problem with a value of a shape, or undefined when it fits. Never echoes the value. */
export function check(shape: Shape, value: string): string | undefined {
  switch (shape.type) {
    case 'enum':
      return shape.values.includes(value) ? undefined : `want one of ${shape.values.join(', ')}`;
    case 'string':
      return value === '' && !shape.empty ? 'must not be empty' : undefined;
    case 'name':
      return NAME.test(value) ? undefined : 'want a lower-case name of letters, digits, and hyphens';
    case 'path':
      if (value === '' && shape.empty) return undefined;
      return isAbsolutePath(value) ? undefined : 'want an absolute path';
    case 'paths':
      return value.split(':').every((entry) => entry === '' || isAbsolutePath(entry)) ? undefined : 'want absolute paths';
    case 'integer': {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) return 'want a whole number';
      const number = Number(value);
      return number >= shape.min && number <= shape.max ? undefined : `want ${shape.min} to ${shape.max}`;
    }
    case 'port': {
      if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535) return 'want a port from 1 to 65535';
      return undefined;
    }
    case 'ip':
      return isIP(value) === 0 ? 'want an IP address' : undefined;
    case 'url': {
      if (value === '' && shape.empty) return undefined;
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return 'want an http or https URL';
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'want an http or https URL';
      if (url.username || url.password || url.search || url.hash) return 'want a URL without credentials, query, or fragment';
      return undefined;
    }
    case 'providers':
      try {
        parseProviders(value);
        return undefined;
      } catch (error) {
        return (error as Error).message;
      }
  }
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') && !value.split('/').includes('..') && !value.includes('\0');
}

export interface ProviderConfig {
  name: string;
  leaseUrl: string;
  cdpHost: string;
  tokenFile: string;
}

const PROVIDER_KEYS = ['name', 'leaseUrl', 'cdpHost', 'tokenFile'];

/** Parse the external-providers list; a malformed entry names its index and key. */
export function parseProviders(value: string): ProviderConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('want a JSON list of providers');
  }
  if (!Array.isArray(parsed)) throw new Error('want a JSON list of providers');
  const names = new Set<string>();
  return parsed.map((entry: unknown, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`entry ${index}: want an object`);
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!PROVIDER_KEYS.includes(key)) throw new Error(`entry ${index}: unknown key ${JSON.stringify(key).slice(0, 40)}`);
    }
    for (const key of PROVIDER_KEYS) {
      if (typeof record[key] !== 'string') throw new Error(`entry ${index}: ${key} must be a string`);
    }
    const provider = record as unknown as ProviderConfig;
    if (!NAME.test(provider.name)) throw new Error(`entry ${index}: name must be a lower-case name`);
    if (names.has(provider.name)) throw new Error(`entry ${index}: name ${provider.name} appears twice`);
    names.add(provider.name);
    const urlProblem = check({ type: 'url' }, provider.leaseUrl);
    if (urlProblem) throw new Error(`entry ${index}: leaseUrl: ${urlProblem}`);
    if (isIP(provider.cdpHost) === 0) throw new Error(`entry ${index}: cdpHost must be an IP address`);
    if (!isAbsolutePath(provider.tokenFile)) throw new Error(`entry ${index}: tokenFile must be an absolute path`);
    return { name: provider.name, leaseUrl: provider.leaseUrl.replace(/\/+$/, ''), cdpHost: provider.cdpHost, tokenFile: provider.tokenFile };
  });
}

/** The tracked .env: every input with its development default, for reading only. */
export function renderEnvFile(): string {
  const lines = [
    '# Generated from config/inputs.json by `node scripts/env.ts`; never edit it, and no process or tool loads it.',
    '# Each input with its development default; an input without one is required in that profile.',
    '',
  ];
  for (const input of schema.inputs) {
    lines.push(`# ${input.description}`);
    const production = input.defaults.production;
    lines.push(`# class: ${input.class}; production default: ${production === undefined ? 'none, required' : JSON.stringify(production)}`);
    const value = input.defaults.development;
    lines.push(value === undefined ? `# ${input.name}=` : `${input.name}=${value}`);
    lines.push('');
  }
  return lines.join('\n');
}
