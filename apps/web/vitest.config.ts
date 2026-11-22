import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The app's tsconfig keeps JSX as-is for Next.js; the tests need it compiled (Vite 8 uses oxc).
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.tsx'],
    // The service worker tests load public/sw.js as text; nothing else touches the file system.
  },
});
