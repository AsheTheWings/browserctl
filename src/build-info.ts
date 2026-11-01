// The revision and version the image build stamps into build-info.json; a source checkout has none.

import { readFileSync } from 'node:fs';

export interface BuildInfo {
  version: string;
  revision: string;
}

let cached: BuildInfo | undefined;

export function buildInfo(): BuildInfo {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(readFileSync(new URL('../build-info.json', import.meta.url), 'utf8')) as Partial<BuildInfo>;
    if (typeof parsed.version === 'string' && typeof parsed.revision === 'string') {
      cached = { version: parsed.version, revision: parsed.revision };
      return cached;
    }
  } catch {
    // A source checkout carries no stamp.
  }
  cached = { version: '0.0.0-source', revision: 'unknown' };
  return cached;
}
