// Copies the brand assets the app serves from packages/ui into public/brand, so there is one source of truth
// and no second copy to keep in step. Runs before `dev` and `build`. public/brand is not committed.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';

const FROM = new URL('../../../packages/ui/assets/brand/', import.meta.url);
const TO = new URL('../public/brand/', import.meta.url);

mkdirSync(TO, { recursive: true });
const files = readdirSync(FROM).filter((f) => /\.(png|svg|ico)$/.test(f));
for (const f of files) cpSync(new URL(f, FROM), new URL(f, TO));
process.stdout.write(`Copied ${files.length} brand files to public/brand.\n`);
