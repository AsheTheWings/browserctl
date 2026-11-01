import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import catalog from '../../src/telemetry/catalog.json' with { type: 'json' };

describe('signal catalog', () => {
  const NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,254}[a-z0-9])?$/;

  it('has the producer catalog shape with units for every metric', () => {
    assert.equal(catalog.schema_version, 'opentelemetry.producer/signal-catalog/v1');
    assert.ok(Number.isInteger(catalog.catalog_version) && catalog.catalog_version >= 1);
    for (const signal of ['traces', 'metrics', 'logs'] as const) {
      for (const name of catalog.catalog[signal]) assert.match(name, NAME);
    }
    assert.deepEqual(Object.keys(catalog.metric_units).sort(), [...catalog.catalog.metrics].sort());
    for (const key of Object.keys(catalog.metric_dimensions)) assert.ok(catalog.allowed_attributes.metrics.includes(key), key);
    const { qualification } = catalog;
    assert.ok(catalog.catalog.traces.includes(qualification.trace_name));
    assert.ok(catalog.catalog.metrics.includes(qualification.metric_name));
    assert.ok(catalog.catalog.logs.includes(qualification.log_name));
    assert.equal(catalog.catalog.correlation_attributes[0], qualification.correlation_attribute);
  });
});
