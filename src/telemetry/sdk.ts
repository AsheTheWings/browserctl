// The OpenTelemetry SDK, set up only by an entry point's composition root from its typed configuration.

import { randomUUID } from 'node:crypto';
import { context, logs, metrics, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, ConsoleLogRecordExporter, LoggerProvider, type LogRecordExporter } from '@opentelemetry/sdk-logs';
import { ConsoleMetricExporter, MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, ConsoleSpanExporter, TracerProvider, type SpanExporter } from '@opentelemetry/sdk-trace';
import { readProtectedFile, type TelemetryConfig } from '../config/config.ts';
import { ConfigError } from '../config/schema.ts';
import { buildInfo } from '../build-info.ts';
import { resetInstruments } from './signals.ts';

export interface Telemetry {
  /** Flush every pending signal under a bounded deadline, then stop exporting. */
  shutdown(): Promise<void>;
}

/** Parse OTEL_EXPORTER_OTLP_HEADERS form: comma-separated key=value pairs, values percent-encoded. */
export function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of text.split(',')) {
    if (pair.trim() === '') continue;
    const index = pair.indexOf('=');
    if (index <= 0) throw new ConfigError(['BROWSERCTL_OTLP_HEADERS_FILE: want key=value pairs separated by commas']);
    const key = pair.slice(0, index).trim();
    let value: string;
    try {
      value = decodeURIComponent(pair.slice(index + 1).trim());
    } catch {
      throw new ConfigError(['BROWSERCTL_OTLP_HEADERS_FILE: a value is not percent-encoded']);
    }
    if (!/^[A-Za-z0-9-]+$/.test(key)) throw new ConfigError(['BROWSERCTL_OTLP_HEADERS_FILE: a header name is invalid']);
    headers[key] = value;
  }
  return headers;
}

const EXPORT_TIMEOUT_MS = 5_000;

export function startTelemetry(config: TelemetryConfig, serviceName: 'browserctl-server' | 'browserctl-admin'): Telemetry {
  const headers = config.headersFile ? parseHeaders(readProtectedFile(config.headersFile, 'BROWSERCTL_OTLP_HEADERS_FILE')) : {};
  const info = buildInfo();
  const resource = resourceFromAttributes({
    'service.namespace': 'browserctl',
    'service.name': serviceName,
    'service.version': info.version,
    'service.instance.id': randomUUID(),
    'deployment.environment.name': config.deploymentEnvironment,
  });
  const otlp = (signal: string) => ({ url: `${config.endpoint}/v1/${signal}`, headers, timeoutMillis: EXPORT_TIMEOUT_MS });

  const spanExporter: SpanExporter | undefined =
    config.traces === 'otlp' ? new OTLPTraceExporter(otlp('traces')) : config.traces === 'console' ? new ConsoleSpanExporter() : undefined;
  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: spanExporter ? [new BatchSpanProcessor({ exporter: spanExporter, exportTimeoutMillis: EXPORT_TIMEOUT_MS, maxQueueSize: 2048 })] : [],
  });

  const metricExporter: PushMetricExporter | undefined =
    config.metrics === 'otlp' ? new OTLPMetricExporter(otlp('metrics')) : config.metrics === 'console' ? new ConsoleMetricExporter() : undefined;
  const meterProvider = new MeterProvider({
    resource,
    readers: metricExporter
      ? [new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 30_000, exportTimeoutMillis: EXPORT_TIMEOUT_MS })]
      : [],
  });

  const logExporter: LogRecordExporter | undefined =
    config.logs === 'otlp' ? new OTLPLogExporter(otlp('logs')) : config.logs === 'console' ? new ConsoleLogRecordExporter() : undefined;
  const loggerProvider = new LoggerProvider({
    resource,
    processors: logExporter ? [new BatchLogRecordProcessor({ exporter: logExporter, exportTimeoutMillis: EXPORT_TIMEOUT_MS, maxQueueSize: 2048 })] : [],
  });

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(tracerProvider);
  metrics.setGlobalMeterProvider(meterProvider);
  logs.setGlobalLoggerProvider(loggerProvider);
  resetInstruments();

  return {
    async shutdown() {
      const bounded = (work: Promise<unknown>) =>
        Promise.race([work.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, EXPORT_TIMEOUT_MS * 2).unref())]);
      await Promise.all([bounded(tracerProvider.shutdown()), bounded(meterProvider.shutdown()), bounded(loggerProvider.shutdown())]);
      trace.disable();
      metrics.disable();
      logs.disable();
      propagation.disable();
      context.disable();
      resetInstruments();
    },
  };
}
