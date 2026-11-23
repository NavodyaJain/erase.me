// Runs the end-to-end suite. `node scripts/e2e.mjs build` only builds the web app for it.
// The web app is built for production (so the service worker is real) against the e2e API on port 4100, in its own
// folder, so it never disturbs `pnpm dev`. Playwright's browser download lives on D: via PLAYWRIGHT_BROWSERS_PATH.
import { spawnSync } from 'node:child_process';

const env = {
  ...process.env,
  NEXT_PUBLIC_API_URL: 'http://localhost:4100',
  NEXT_DIST_DIR: '.next-e2e',
  NEXT_TELEMETRY_DISABLED: '1',
};

function run(command, args) {
  const r = spawnSync(command, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run('pnpm', ['exec', 'next', 'build']);
if (process.argv[2] !== 'build') run('pnpm', ['exec', 'playwright', 'test', ...process.argv.slice(2)]);
