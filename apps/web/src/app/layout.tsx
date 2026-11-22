import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@erase/ui/tokens.css';
import '@erase/ui/styles.css';
import '@fontsource-variable/inter/wght.css';
import './globals.css';
import { AppProviders } from '@/lib/providers';

export const metadata: Metadata = {
  title: { default: 'Erase.me', template: '%s | Erase.me' },
  description: 'See which companies may hold your data, and ask them to erase it. Nothing is sent without your approval.',
  applicationName: 'Erase.me',
  icons: { icon: [{ url: '/brand/favicon.svg', type: 'image/svg+xml' }, { url: '/brand/favicon-32.png', sizes: '32x32', type: 'image/png' }], apple: '/brand/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'Erase', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: '#2F55F4',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
