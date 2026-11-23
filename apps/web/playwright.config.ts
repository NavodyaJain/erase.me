import { defineConfig } from '@playwright/test';

const API = 'http://localhost:4100';
const WEB = 'http://localhost:3100';
const ci = Boolean(process.env.CI);

/**
 * End-to-end tests. The API runs its e2e entry (a dedicated database, a fake Google and a fake Gmail, fictional
 * data only) and the web app runs its production build. Tests share one database, so they run one at a time and each
 * starts by wiping it. No retries: a flaky test should fail loudly.
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: ci,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    serviceWorkers: 'allow',
    locale: 'en-GB',
    timezoneId: 'UTC',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } }],
  webServer: [
    {
      command: 'pnpm --filter @erase/api e2e:server',
      cwd: '../..',
      url: `${API}/healthz`,
      env: { E2E_MODE: 'true' },
      reuseExistingServer: false,
      timeout: 90_000,
    },
    {
      command: 'pnpm exec next start -p 3100',
      url: `${WEB}/offline`,
      env: { NEXT_PUBLIC_API_URL: API, NEXT_DIST_DIR: '.next-e2e' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
