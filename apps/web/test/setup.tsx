import { cleanup } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import * as matchers from 'vitest-axe/matchers';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { nav, resetNav } from './navigation';

expect.extend(matchers);

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace, push: nav.push, back: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

beforeEach(() => resetNav());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
