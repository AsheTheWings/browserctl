// The managed-session limit: requests beyond it wait in order for a free place, up to a deadline.

import { BrowserctlError } from '../errors.ts';

export class Slots {
  readonly #limit: number;
  #used = 0;
  readonly #waiting: Array<{ grant: () => void }> = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  get used(): number {
    return this.#used;
  }

  /** Wait up to timeoutMs for a place; the returned function gives it back exactly once. */
  acquire(timeoutMs: number): Promise<() => void> {
    const release = () => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = this.#waiting.shift();
        if (next) next.grant();
        else this.#used -= 1;
      };
    };
    if (this.#used < this.#limit) {
      this.#used += 1;
      return Promise.resolve(release());
    }
    return new Promise((resolve, reject) => {
      const waiter = { grant: () => {
        clearTimeout(timer);
        resolve(release());
      } };
      const timer = setTimeout(() => {
        const index = this.#waiting.indexOf(waiter);
        if (index >= 0) this.#waiting.splice(index, 1);
        reject(new BrowserctlError('capacity', 'every managed browser is in use; try again later'));
      }, timeoutMs);
      this.#waiting.push(waiter);
    });
  }
}
