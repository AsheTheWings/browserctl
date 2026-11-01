// Service checks: each service of a profile names a check task, which runs in a fresh check session from the
// profile's current revision every check interval and on request; a passing run marks the service signed in and a
// failing one signed out.

import { BrowserctlError } from '../errors.ts';
import type { ProfileStore, ServiceCheck } from '../profiles/store.ts';
import type { SessionManager } from '../sessions/manager.ts';
import { emitEvent, inSpan, instrument } from '../telemetry/signals.ts';
import type { TaskRunner } from './runner.ts';

/** The reserved client name check sessions and runs are attributed to. */
export const CHECK_CLIENT = 'browserctl';

export interface ServiceCheckOptions {
  profiles: ProfileStore;
  sessions: SessionManager;
  runner: TaskRunner;
  intervalSeconds: number;
}

export class ServiceChecks {
  readonly #options: ServiceCheckOptions;
  /** Checks in progress by profile and service, so a request joins a running check instead of starting another. */
  readonly #running = new Map<string, Promise<ServiceCheck | undefined>>();
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(options: ServiceCheckOptions) {
    this.#options = options;
  }

  start(): void {
    this.#timer = setInterval(() => void this.checkAll(), this.#options.intervalSeconds * 1000);
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
  }

  /** Check every service of every profile, one at a time, so checks never crowd out agent sessions. */
  async checkAll(): Promise<void> {
    for (const profile of await this.#options.profiles.list()) {
      for (const service of profile.services) {
        if (this.#stopped) return;
        await this.check(profile.name, service.name).catch(() => undefined);
      }
    }
  }

  /**
   * Run one service's check task and record its result. A run that ends in an error, such as a model that did not
   * answer, says nothing about the sign-in state, so it leaves the last result in place and returns nothing.
   */
  check(profile: string, service: string): Promise<ServiceCheck | undefined> {
    const key = `${profile}/${service}`;
    const running = this.#running.get(key);
    if (running) return running;
    const check = this.#check(profile, service).finally(() => this.#running.delete(key));
    this.#running.set(key, check);
    return check;
  }

  #check(profileName: string, serviceName: string): Promise<ServiceCheck | undefined> {
    const { profiles, sessions, runner } = this.#options;
    return inSpan('browserctl.service.check', {}, async (span) => {
      const profile = await profiles.get(profileName);
      const service = profile.services.find((entry) => entry.name === serviceName);
      if (!service) throw new BrowserctlError('not_found', `profile ${profileName} has no service ${serviceName}`);
      const session = await sessions.open(CHECK_CLIENT, { kind: 'profile', profile: profileName }, 'check');
      span.setAttribute('browserctl.session.id', session.id);
      let result;
      try {
        result = await runner.run(session, CHECK_CLIENT, service.task);
      } finally {
        await sessions.close(session, 'closed');
      }
      if (result.status === 'error') {
        span.setAttribute('error.type', result.errorClass ?? 'internal');
        return undefined;
      }
      const check: ServiceCheck = { result: result.status === 'passed' ? 'signed_in' : 'signed_out', time: new Date().toISOString(), run: result.run };
      await profiles.update(profileName, (current) => {
        const entry = current.services.find((candidate) => candidate.name === serviceName);
        if (entry) entry.lastCheck = check;
      });
      span.setAttribute('browserctl.check_result', check.result);
      instrument().serviceChecks.add(1, { 'browserctl.check_result': check.result });
      if (check.result === 'signed_out') {
        emitEvent('browserctl.service.signed_out', { 'browserctl.session.id': session.id, 'browserctl.profile': profileName, 'browserctl.service': serviceName });
      }
      return check;
    });
  }
}
