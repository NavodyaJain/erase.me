import { assertDevHelperAllowed, registerDevHelper } from './dev-helper.js';
import { reportStartupFailure, start } from '../start.js';
import { loadEnv } from '../config/env.js';

// Development entry point (`pnpm dev`). The production entry is src/server.ts and never imports ./dev.
const env = loadEnv();
assertDevHelperAllowed(env);

start({
  postAuthRedirect: new URL('/dev/connect', env.API_PUBLIC_URL).toString(),
  plugins: [({ env: e, app, db }) => registerDevHelper(app, { env: e, db })],
}).catch(reportStartupFailure);
