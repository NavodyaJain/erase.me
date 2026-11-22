import base, { browserGlobals } from '@erase/config/eslint/base';

export default [
  ...base,
  { files: ['src/**/*.{ts,tsx}'], languageOptions: { globals: { ...browserGlobals } } },
  // The hand-written service worker runs in a worker scope, not a page.
  {
    files: ['public/sw.js'],
    languageOptions: { sourceType: 'script', globals: { self: 'readonly', caches: 'readonly', fetch: 'readonly', URL: 'readonly' } },
  },
];
