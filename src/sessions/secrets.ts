// Session-scoped secrets: short-lived single-use HTTP upload capabilities, in-memory storage per session,
// placeholder substitution for browser input tools, and text redaction for tool results.

import { randomBytes } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BrowserctlError } from '../errors.ts';

export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
export const SECRET_CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
export const MAX_SECRET_BYTES = 64 * 1024;
export const MAX_SECRETS_PER_SESSION = 64;
export const MAX_PENDING_UPLOADS_PER_SESSION = 16;
export const UPLOAD_TTL_MS = 60_000;

export type SecretUploadFormat = 'value' | 'env';

export interface PrepareUploadOptions {
  format: SecretUploadFormat;
  name?: string;
  trimNewline: boolean;
}

interface PendingUpload {
  sessionId: string;
  client: string;
  format: SecretUploadFormat;
  name?: string;
  trimNewline: boolean;
  expiresAt: number;
}

const PLACEHOLDER = /\{\{secret:([^}]*)\}\}/g;

/** Parse NAME=value lines (unwrapping matching single or double quotes without escape expansion), skipping blank lines and # comments. */
export function parseEnvSecrets(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!.endsWith('\r') ? lines[index]!.slice(0, -1) : lines[index]!;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = raw.indexOf('=');
    if (eq <= 0) throw new BrowserctlError('invalid_request', `line ${index + 1}: expected NAME=value`);
    const name = raw.slice(0, eq);
    let value = raw.slice(eq + 1);
    if (value.length >= 2 && ((value[0] === "'" && value.at(-1) === "'") || (value[0] === '"' && value.at(-1) === '"'))) {
      value = value.slice(1, -1);
    }
    if (!SECRET_NAME.test(name)) throw new BrowserctlError('invalid_request', `line ${index + 1}: invalid secret name`);
    if (entries.has(name)) throw new BrowserctlError('invalid_request', `line ${index + 1}: duplicate secret ${name}`);
    if (value.length === 0) throw new BrowserctlError('invalid_request', `line ${index + 1}: secret ${name} must not be empty`);
    entries.set(name, value);
  }
  if (entries.size === 0) throw new BrowserctlError('invalid_request', 'no secrets found in uploaded body');
  return entries;
}

/** Parse an uploaded secret body according to the prepared upload's format and optional name filter. */
export function parseUploadedSecrets(body: Buffer, options: PrepareUploadOptions): Map<string, string> {
  if (body.length > MAX_SECRET_BYTES) {
    throw new BrowserctlError('invalid_request', `secret upload is limited to ${MAX_SECRET_BYTES} bytes`);
  }
  const text = body.toString('utf8');
  if (options.format === 'value') {
    if (!options.name || !SECRET_NAME.test(options.name)) {
      throw new BrowserctlError('invalid_request', 'a valid secret name is required');
    }
    const value = options.trimNewline ? text.replace(/\r?\n$/, '') : text;
    if (value.length === 0) throw new BrowserctlError('invalid_request', `secret ${options.name} must not be empty`);
    return new Map([[options.name, value]]);
  }
  const parsed = parseEnvSecrets(text);
  if (options.name !== undefined) {
    const selected = parsed.get(options.name);
    if (selected === undefined) {
      throw new BrowserctlError('invalid_request', `secret ${options.name} was not found in uploaded body`);
    }
    return new Map([[options.name, selected]]);
  }
  return parsed;
}

/** Replace {{secret:NAME}} placeholders in text using the session's loaded secrets; fails closed on unknown names. */
export function resolveSecretPlaceholders(text: string, secrets: ReadonlyMap<string, string>): string {
  if (!text.includes('{{secret:')) return text;
  return text.replace(PLACEHOLDER, (_match, rawName: string) => {
    if (!SECRET_NAME.test(rawName)) {
      throw new BrowserctlError('invalid_request', 'invalid secret placeholder name');
    }
    const value = secrets.get(rawName);
    if (value === undefined) {
      throw new BrowserctlError('invalid_request', `secret ${rawName} is not loaded in this session`);
    }
    return value;
  });
}

/** Resolve secret placeholders in supported browser input tool arguments without mutating the caller's object. */
export function substituteBrowserToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  secrets: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (toolName === 'browser_type' && typeof args.text === 'string') {
    const resolved = resolveSecretPlaceholders(args.text, secrets);
    return resolved === args.text ? args : { ...args, text: resolved };
  }
  if (toolName === 'browser_fill_form' && Array.isArray(args.fields)) {
    let changed = false;
    const fields = args.fields.map((field) => {
      if (field && typeof field === 'object' && typeof (field as { value?: unknown }).value === 'string') {
        const original = (field as { value: string }).value;
        const resolved = resolveSecretPlaceholders(original, secrets);
        if (resolved !== original) {
          changed = true;
          return { ...field, value: resolved };
        }
      }
      return field;
    });
    return changed ? { ...args, fields } : args;
  }
  return args;
}

function escapeSingleQuotedJs(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/** Scrub loaded secret values (raw, JSON-escaped, and single-quoted JS-escaped) from text. */
export function redactText(text: string, secrets: ReadonlyMap<string, string>): string {
  if (secrets.size === 0 || text.length === 0) return text;
  const patterns: Array<{ needle: string; replacement: string }> = [];
  for (const [name, value] of secrets) {
    if (!value) continue;
    const replacement = `<secret>${name}</secret>`;
    const candidates = new Set<string>([
      value,
      JSON.stringify(value).slice(1, -1),
      escapeSingleQuotedJs(value),
    ]);
    for (const needle of candidates) {
      if (needle.length > 0) patterns.push({ needle, replacement });
    }
  }
  patterns.sort((a, b) => b.needle.length - a.needle.length);
  let output = text;
  for (const { needle, replacement } of patterns) {
    output = output.replaceAll(needle, replacement);
  }
  return output;
}

/** Scrub loaded secret values from every text block in a tool result. */
export function redactToolResult(result: CallToolResult, secrets: ReadonlyMap<string, string>): CallToolResult {
  if (secrets.size === 0) return result;
  let changed = false;
  const content = result.content.map((item) => {
    if (item.type !== 'text') return item;
    const redacted = redactText(item.text, secrets);
    if (redacted === item.text) return item;
    changed = true;
    return { ...item, text: redacted };
  });
  return changed ? { ...result, content } : result;
}

const EMPTY_SECRETS: ReadonlyMap<string, string> = new Map();

/** In-memory secret store and single-use upload capability registry for live sessions. */
export class SessionSecretStore {
  readonly #sessions = new Map<string, Map<string, string>>();
  readonly #uploads = new Map<string, PendingUpload>();

  prepareUpload(
    sessionId: string,
    client: string,
    options: PrepareUploadOptions,
    now = Date.now(),
  ): { capability: string; expiresAt: number } {
    this.sweep(now);
    if (options.format !== 'value' && options.format !== 'env') {
      throw new BrowserctlError('invalid_request', 'format must be value or env');
    }
    if (options.format === 'value') {
      if (typeof options.name !== 'string' || !SECRET_NAME.test(options.name)) {
        throw new BrowserctlError('invalid_request', 'a valid secret name is required');
      }
    } else if (options.name !== undefined && (typeof options.name !== 'string' || !SECRET_NAME.test(options.name))) {
      throw new BrowserctlError('invalid_request', 'secret name must start with a letter or underscore and use letters, digits, underscores, or hyphens');
    }
    let pending = 0;
    for (const entry of this.#uploads.values()) {
      if (entry.sessionId === sessionId) pending += 1;
    }
    if (pending >= MAX_PENDING_UPLOADS_PER_SESSION) {
      throw new BrowserctlError('conflict', 'too many pending secret uploads for this session');
    }
    const capability = randomBytes(32).toString('base64url');
    const expiresAt = now + UPLOAD_TTL_MS;
    this.#uploads.set(capability, {
      sessionId,
      client,
      format: options.format,
      ...(options.name !== undefined && { name: options.name }),
      trimNewline: options.trimNewline,
      expiresAt,
    });
    return { capability, expiresAt };
  }

  /** Consume a single-use upload capability and store its parsed secrets on the session. */
  consumeUpload(
    capability: string,
    body: Buffer,
    isSessionActive: (sessionId: string) => boolean,
    now = Date.now(),
  ): { sessionId: string; client: string; loaded: string[] } {
    const entry = this.#uploads.get(capability);
    if (!entry) throw new BrowserctlError('not_found', 'upload link is invalid or expired');
    this.#uploads.delete(capability);
    if (entry.expiresAt <= now || !isSessionActive(entry.sessionId)) {
      throw new BrowserctlError('not_found', 'upload link is invalid or expired');
    }
    const incoming = parseUploadedSecrets(body, {
      format: entry.format,
      ...(entry.name !== undefined && { name: entry.name }),
      trimNewline: entry.trimNewline,
    });
    const current = this.#sessions.get(entry.sessionId) ?? new Map<string, string>();
    let added = 0;
    for (const name of incoming.keys()) {
      if (!current.has(name)) added += 1;
    }
    if (current.size + added > MAX_SECRETS_PER_SESSION) {
      throw new BrowserctlError('invalid_request', `a session may hold at most ${MAX_SECRETS_PER_SESSION} secrets`);
    }
    for (const [name, value] of incoming) current.set(name, value);
    this.#sessions.set(entry.sessionId, current);
    return { sessionId: entry.sessionId, client: entry.client, loaded: [...incoming.keys()].sort() };
  }

  getMap(sessionId: string): ReadonlyMap<string, string> {
    return this.#sessions.get(sessionId) ?? EMPTY_SECRETS;
  }

  list(sessionId: string): string[] {
    const current = this.#sessions.get(sessionId);
    return current ? [...current.keys()].sort() : [];
  }

  clear(sessionId: string, name?: string): string[] {
    const current = this.#sessions.get(sessionId);
    if (!current || current.size === 0) return [];
    if (name !== undefined) {
      if (!SECRET_NAME.test(name)) {
        throw new BrowserctlError('invalid_request', 'secret name must start with a letter or underscore and use letters, digits, underscores, or hyphens');
      }
      if (!current.delete(name)) return [];
      if (current.size === 0) this.#sessions.delete(sessionId);
      return [name];
    }
    const cleared = [...current.keys()].sort();
    this.#sessions.delete(sessionId);
    return cleared;
  }

  deleteSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
    for (const [capability, entry] of this.#uploads) {
      if (entry.sessionId === sessionId) this.#uploads.delete(capability);
    }
  }

  sweep(now = Date.now()): void {
    for (const [capability, entry] of this.#uploads) {
      if (entry.expiresAt <= now) this.#uploads.delete(capability);
    }
  }

  clearAll(): void {
    this.#sessions.clear();
    this.#uploads.clear();
  }
}
