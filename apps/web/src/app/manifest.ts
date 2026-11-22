import type { MetadataRoute } from 'next';

/** The web app manifest (F14): installable, standalone, with the brand icons that scripts/sync-brand.mjs copies in. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Erase.me',
    short_name: 'Erase',
    description: 'See which companies may hold your data, and ask them to erase it. Nothing is sent without your approval.',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    theme_color: '#2F55F4',
    background_color: '#F5F6F8',
    icons: [
      { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/brand/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
