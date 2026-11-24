// The managed-session limit: requests beyond it fail fast or wait in order for a free place, up to a deadline.

import { BrowserctlError } from '../errors.ts';

export interface SlotCapacity {
  total: number;
  used: number;
  available: number;
  queued: number;
}

export class Slots {
  readonly #limit: number;
  #used = 0;
  readonly #waiting: Array<{ grant: () => void; refuse: (error: Error) => void }> = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  get limit(): number {
    return this.#limit;
  }

  get used(): number {
    return this.#used;
  }

  get waiting(): number {
    return this.#waiting.length;
  }

  capacity(): SlotCapacity {
    return {
      total: this.#limit,
      used: this.#used,
      available: Math.max(0, this.#limit - this.#used),
      queued: this.#waiting.length,
    };
  }

  /** Wait up to timeoutMs for a place (0 fails immediately when full); the returned function gives it back once. */
  acquire(timeoutMs: number, signal?: AbortSignal): Promise<() => void> {
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
    if (timeoutMs <= 0) {
      return Promise.reject(new BrowserctlError('capacity', 'every managed browser is in use; try again later'));
    }
    if (signal?.aborted) {
      return Promise.reject(new BrowserctlError('invalid_request', 'the session request was canceled'));
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const removeWaiter = () => {
        const index = this.#waiting.indexOf(waiter);
        if (index >= 0) this.#waiting.splice(index, 1);
      };
      const waiter = {
        grant: () => {
          cleanup();
          resolve(release());
        },
        refuse: (error: Error) => {
          cleanup();
          reject(error);
        },
      };
      const onAbort = () => {
        removeWaiter();
        cleanup();
        reject(new BrowserctlError('invalid_request', 'the session request was canceled'));
      };
      const timer = setTimeout(() => {
        removeWaiter();
        cleanup();
        reject(new BrowserctlError('capacity', 'every managed browser is in use; try again later'));
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiting.push(waiter);
    });
  }

  /** Refuse every waiting request with an error. */
  refuseWaiting(error: Error): void {
    for (const waiter of this.#waiting.splice(0)) waiter.refuse(error);
  }
}
