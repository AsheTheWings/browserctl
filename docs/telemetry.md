# Telemetry

What diagnostics does browserctl emit, and where do they go?

The server and the admin command emit diagnostics only through
OpenTelemetry: spans for operations, log records for searchable events, and
metrics for rates and durations. Their command output and error messages are
not telemetry.

[`src/telemetry/catalog.json`](../src/telemetry/catalog.json) is the
versioned signal catalog: every span, metric, and log record name, the
attributes each signal may carry, metric units and dimension values, and the
error classes `error.type` takes. Its format is the producer signal catalog
that collectors derive their registrations from. A log record's body is its
cataloged event name. Tests check emitted signals against it.

## Export

`OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, and `OTEL_LOGS_EXPORTER` each
select `otlp` (the default), `console`, or `none`. OTLP goes over HTTP with
protobuf to `OTEL_EXPORTER_OTLP_ENDPOINT` followed by `/v1/traces`,
`/v1/metrics`, and `/v1/logs`, with the headers in the protected file that
`BROWSERCTL_OTLP_HEADERS_FILE` names, in `OTEL_EXPORTER_OTLP_HEADERS` form.
Exports are batched, time out after 5 seconds, and are flushed at shutdown; a
failed export is dropped.

Every signal carries `service.namespace` `browserctl`, `service.name`
`browserctl-server` or `browserctl-admin`, the build's `service.version`, a
per-process `service.instance.id`, and `deployment.environment.name` from
`BROWSERCTL_DEPLOYMENT_ENVIRONMENT`. Trace context propagates in W3C Trace
Context form.

No signal carries a token, capability URL, cookie, page content, task input or
output, or model payload. Failures are reported by their error class.

`browserctl admin telemetry-probe` emits one `browserctl.qualification` span,
metric point, and log record, so a collector registration can be verified.
