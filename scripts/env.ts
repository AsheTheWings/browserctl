// Print the tracked .env from the input schema: `node scripts/env.ts > .env`.
import { renderEnvFile } from '../src/config/schema.ts';

process.stdout.write(renderEnvFile());
