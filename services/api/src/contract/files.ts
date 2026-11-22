import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** services/api/openapi/openapi.json, reached from both src/contract and dist/contract. */
export const OPENAPI_PATH = path.resolve(here, '../../openapi/openapi.json');

/** Line endings are normalised, so a Windows checkout with CRLF is not "out of date". */
export const normalise = (s: string): string => s.replace(/\r\n/g, '\n');

export function readCommitted(): string | undefined {
  try {
    return normalise(readFileSync(OPENAPI_PATH, 'utf8'));
  } catch {
    return undefined;
  }
}
