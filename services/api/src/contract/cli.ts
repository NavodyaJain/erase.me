// `pnpm --filter @erase/api openapi:generate` writes openapi/openapi.json from the contract schemas.
// `pnpm --filter @erase/api openapi:check` fails (exit 1) if the committed file is out of date. CI runs the check.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { OPENAPI_PATH, readCommitted } from './files.js';
import { serializeOpenApi } from './openapi.js';

const generated = serializeOpenApi();

if (process.argv.includes('--check')) {
  if (readCommitted() === generated) {
    process.stdout.write('openapi.json is up to date.\n');
  } else {
    process.stderr.write('openapi.json is out of date. Run `pnpm --filter @erase/api openapi:generate` and commit the result.\n');
    process.exit(1);
  }
} else {
  writeFileSync(OPENAPI_PATH, generated, 'utf8');
  process.stdout.write(`Wrote ${path.relative(process.cwd(), OPENAPI_PATH)}.\n`);
}
