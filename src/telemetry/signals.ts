// The signals browserctl emits, through the OpenTelemetry API only. Names and attributes follow catalog.json.

import { SeverityNumber, SpanStatusCode, logs, metrics, trace, type Attributes, type Span } from '@opentelemetry/api';
import { errorClassOf } from '../errors.ts';

const SCOPE = 'browserctl';

export function tracer() {
  return trace.getTracer(SCOPE);
}

/** Run work in a span; a failure sets the span's error.type to the error's class and rethrows. */
export async function inSpan<T>(name: string, attributes: Attributes, work: (span: Span) => Promise<T>): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.setAttribute('error.type', errorClassOf(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Emit a searchable event: its body is the cataloged event name. */
export function emitEvent(name: string, attributes: Attributes, severity: 'info' | 'warn' | 'error' = 'warn'): void {
  const severityNumber = { info: SeverityNumber.INFO, warn: SeverityNumber.WARN, error: SeverityNumber.ERROR }[severity];
  logs.getLogger(SCOPE).emit({ body: name, severityNumber, severityText: severity.toUpperCase(), attributes });
}

function meter() {
  return metrics.getMeter(SCOPE);
}

let instruments: ReturnType<typeof createInstruments> | undefined;

function createInstruments() {
  const m = meter();
  return {
    qualification: m.createCounter('browserctl.qualification', { unit: '{probe}', description: 'Telemetry qualification probes.' }),
    sessionsLive: m.createUpDownCounter('browserctl.sessions.live', { unit: '{session}', description: 'Live sessions by source.' }),
    queueWait: m.createHistogram('browserctl.session.queue.wait', {
      unit: 's',
      description: 'Time a managed session request waited for a free place.',
    }),
    frames: m.createCounter('browserctl.screencast.frames', { unit: '{frame}', description: 'Screencast frames delivered, by stream.' }),
    taskRunDuration: m.createHistogram('browserctl.task.run.duration', { unit: 's', description: 'Task run durations by status.' }),
    serviceChecks: m.createCounter('browserctl.service.checks', { unit: '{check}', description: 'Service check results.' }),
  };
}

/** Instruments bound to the meter provider registered when they are first used. */
export function instrument() {
  instruments ??= createInstruments();
  return instruments;
}

/** Forget the instruments, so the next use binds to a newly registered meter provider; tests only. */
export function resetInstruments(): void {
  instruments = undefined;
}
