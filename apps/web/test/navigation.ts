import { vi } from 'vitest';

/** The router state the tests control. `next/navigation` is mocked globally in test/setup.ts to read from here. */
export const nav = {
  pathname: '/overview',
  search: '',
  replace: vi.fn(),
  push: vi.fn(),
};

export function resetNav(pathname = '/overview', search = ''): void {
  nav.pathname = pathname;
  nav.search = search;
  nav.replace.mockClear();
  nav.push.mockClear();
}
