'use client';

import { Button } from '@erase/ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { copy } from '@/copy/en';
import { useSignOut } from '@/lib/session';

const NAV = [
  { href: '/overview', label: copy.nav.overview },
  { href: '/requests', label: copy.nav.requests },
  { href: '/connect', label: copy.nav.inboxes },
] as const;

/**
 * The signed-in frame: a bottom tab bar on a phone, a side bar from 1024px. Only the screens Phase 1 builds are listed.
 * Phone safe-area insets are respected for the installed (standalone) app.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const signOut = useSignOut();

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        {copy.nav.skip}
      </a>
      <header className="app-header">
        <Link href="/overview" className="app-brand" aria-label={copy.brand.name}>
          <img src="/brand/logo-wordmark-light.svg" alt="" width={112} height={28} />
        </Link>
        <Button
          variant="secondary"
          loading={signOut.isPending}
          onClick={() => signOut.mutate(undefined, { onSettled: () => router.replace('/') })}
        >
          {copy.common.signOut}
        </Button>
      </header>
      <nav className="app-nav" aria-label={copy.nav.main}>
        <ul>
          {NAV.map((item) => {
            const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <li key={item.href}>
                <Link href={item.href} aria-current={current ? 'page' : undefined} className="app-nav-link">
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <main id="main" className="app-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
