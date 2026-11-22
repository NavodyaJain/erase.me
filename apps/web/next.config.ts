import type { NextConfig } from 'next';
import { resolveApiUrl } from './src/lib/config';

const apiOrigin = resolveApiUrl();
const dev = process.env.NODE_ENV !== 'production';

/**
 * A content-security-policy that only lets the page talk to itself and to the API origin. Next.js needs inline
 * scripts to hydrate, so `script-src` allows them (a nonce-based policy is a later hardening). Everything else is closed.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${apiOrigin}${dev ? ' ws:' : ''}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@erase/ui', '@erase/api-client', '@erase/contracts'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      // The service worker must never be served from a cache, or an update could not reach people.
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Type', value: 'text/javascript; charset=utf-8' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      { source: '/manifest.webmanifest', headers: [{ key: 'Content-Type', value: 'application/manifest+json' }] },
    ];
  },
};

export default config;
