// Generates src/schema.d.ts from the committed OpenAPI document.
//   node scripts/generate.mjs           writes the file
//   node scripts/generate.mjs --check   fails (exit 1) if the file is out of date; `pnpm test` and CI run this
import { readFileSync, writeFileSync } from 'node:fs';
import openapiTS, { astToString } from 'openapi-typescript';

const SPEC = new URL('../../../services/api/openapi/openapi.json', import.meta.url);
const OUT = new URL('../src/schema.d.ts', import.meta.url);
const HEADER =
  '/* Generated from services/api/openapi/openapi.json by `pnpm --filter @erase/contracts generate`. Do not edit. */\n\n';

const normalise = (s) => s.replace(/\r\n/g, '\n');
const generated = HEADER + astToString(await openapiTS(SPEC));

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = normalise(readFileSync(OUT, 'utf8'));
  } catch {
    // missing file: out of date
  }
  if (current === generated) {
    process.stdout.write('schema.d.ts is up to date.\n');
  } else {
    process.stderr.write(
      'packages/contracts/src/schema.d.ts is out of date. Run `pnpm --filter @erase/contracts generate` and commit the result.\n',
    );
    process.exit(1);
  }
} else {
  writeFileSync(OUT, generated, 'utf8');
  process.stdout.write('Wrote packages/contracts/src/schema.d.ts.\n');
}
