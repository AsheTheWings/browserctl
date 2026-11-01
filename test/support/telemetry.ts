// In-memory OpenTelemetry providers for tests, and a check of emitted signals against the signal catalog.

import assert from 'node:assert/strict';
import { logs, metrics, trace } from '@opentelemetry/api';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { context } from '@opentelemetry/api';
import catalog from '../../src/telemetry/catalog.json' with { type: 'json' };
import { resetInstruments } from '../../src/telemetry/signals.ts';
import type { Telemetry } from '../../src/telemetry/sdk.ts';

export interface Recorded {
  spans: Array<{ name: string; attributes: Record<string, unknown> }>;
  metrics: Array<{ name: string; unit: string; attributes: Record<string, unknown> }>;
  logs: Array<{ body: unknown; attributes: Record<string, unknown> }>;
}

export interface MemoryTelemetry {
  collect(): Promise<Recorded>;
  restore(): Promise<void>;
}

/** Register in-memory providers globally until restore() puts the no-op API back. */
export function memoryTelemetry(): MemoryTelemetry {
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spanExporter })] });
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3_600_000 });
  const meterProvider = new MeterProvider({ readers: [reader] });
  const logExporter = new InMemoryLogRecordExporter();
  const loggerProvider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: logExporter })] });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(tracerProvider);
  metrics.setGlobalMeterProvider(meterProvider);
  logs.setGlobalLoggerProvider(loggerProvider);
  resetInstruments();
  return {
    async collect() {
      await reader.forceFlush();
      const recorded: Recorded = {
        spans: spanExporter.getFinishedSpans().map((span) => ({ name: span.name, attributes: { ...span.attributes } })),
        metrics: [],
        logs: logExporter.getFinishedLogRecords().map((record) => ({ body: record.body, attributes: { ...record.attributes } })),
      };
      for (const resourceMetrics of metricExporter.getMetrics()) {
        for (const scope of resourceMetrics.scopeMetrics) {
          for (const metric of scope.metrics) {
            for (const point of metric.dataPoints) {
              recorded.metrics.push({ name: metric.descriptor.name, unit: metric.descriptor.unit, attributes: { ...point.attributes } });
            }
          }
        }
      }
      return recorded;
    },
    async restore() {
      await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown(), loggerProvider.shutdown()]);
      trace.disable();
      metrics.disable();
      logs.disable();
      context.disable();
      resetInstruments();
    },
  };
}

/** A telemetry starter for the CLI that leaves the in-memory providers in place. */
export const keepTelemetry = (): Telemetry => ({ shutdown: async () => undefined });

const SECRET_LIKE = /bctl_|Bearer|\/cdp\/[A-Za-z0-9_-]{20,}/;

/** Every recorded signal is cataloged with only its allowed attributes, cataloged values, and no secret. */
export function assertCataloged(recorded: Recorded): void {
  const dimensions = catalog.metric_dimensions as Record<string, string[]>;
  const units = catalog.metric_units as Record<string, string>;
  const checkAttributes = (signal: 'traces' | 'metrics' | 'logs', name: string, attributes: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(attributes)) {
      assert.ok(catalog.allowed_attributes[signal].includes(key), `${signal} ${name}: attribute ${key} is not cataloged`);
      if (key === 'error.type') assert.ok(catalog.error_classes.includes(String(value)), `${name}: error class ${String(value)}`);
      if (dimensions[key]) assert.ok(dimensions[key].includes(String(value)), `${name}: ${key}=${String(value)} is not a cataloged value`);
      assert.doesNotMatch(String(value), SECRET_LIKE, `${name}: ${key} looks like a secret`);
    }
  };
  for (const span of recorded.spans) {
    assert.ok(catalog.catalog.traces.includes(span.name), `span ${span.name} is not cataloged`);
    checkAttributes('traces', span.name, span.attributes);
  }
  for (const metric of recorded.metrics) {
    assert.ok(catalog.catalog.metrics.includes(metric.name), `metric ${metric.name} is not cataloged`);
    assert.equal(metric.unit, units[metric.name], `metric ${metric.name} unit`);
    checkAttributes('metrics', metric.name, metric.attributes);
  }
  for (const record of recorded.logs) {
    assert.ok(catalog.catalog.logs.includes(String(record.body)), `log ${String(record.body)} is not cataloged`);
    checkAttributes('logs', String(record.body), record.attributes);
  }
}
