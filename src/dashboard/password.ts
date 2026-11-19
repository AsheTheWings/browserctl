import { createHash, timingSafeEqual } from 'node:crypto';
import { DASHBOARD_PASSWORD_INPUT, readProtectedFile } from '../config/config.ts';
import { BrowserctlError } from '../errors.ts';

const ATTEMPT_WINDOW_MS = 60_000;
const MAX_FAILURES = 10;
const digest = (password: string) => createHash('sha256').update(password).digest();

export class PasswordSignIn {
  readonly #file: string;
  #failures = 0;
  #windowEnds = 0;

  constructor(file: string) {
    this.#file = file;
  }

  verify(password: unknown, now = Date.now()): void {
    if (now >= this.#windowEnds) {
      this.#windowEnds = now + ATTEMPT_WINDOW_MS;
      this.#failures = 0;
    }
    if (this.#failures >= MAX_FAILURES) throw new BrowserctlError('sign_in_throttled', 'Too many attempts. Try again in a minute.');

    let expected: string;
    try {
      expected = readProtectedFile(this.#file, DASHBOARD_PASSWORD_INPUT, false);
    } catch {
      throw new BrowserctlError('auth_unavailable', 'Password sign-in is unavailable.');
    }
    if (typeof password !== 'string' || !timingSafeEqual(digest(password), digest(expected))) {
      this.#failures += 1;
      throw new BrowserctlError('unauthorized', 'Incorrect dashboard password.');
    }
    this.#failures = 0;
  }
}
