/**
 * Where the browser sends API calls. Set `NEXT_PUBLIC_API_URL` (see apps/web/.env.example). The localhost default
 * exists for development only: a production build without it fails instead of quietly calling the wrong server.
 * The API's own `WEB_ORIGIN` must be this web app's origin (docs/runbooks/web-origin.md).
 */
export function resolveApiUrl(env: { NEXT_PUBLIC_API_URL?: string | undefined; NODE_ENV?: string | undefined } = process.env): string {
  const configured = env.NEXT_PUBLIC_API_URL?.trim();
  if (configured) return new URL(configured).origin;
  if (env.NODE_ENV === 'production') throw new Error('NEXT_PUBLIC_API_URL is not set. Set it to the API origin, for example https://api.example.com.');
  return 'http://localhost:4000';
}

// Next replaces only the literal `process.env.NEXT_PUBLIC_API_URL` when it builds the browser bundle. Passing the whole
// `process.env` object would leave the browser with no value and the localhost default. The end-to-end suite catches that.
export const API_URL = resolveApiUrl({ NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL, NODE_ENV: process.env.NODE_ENV });
