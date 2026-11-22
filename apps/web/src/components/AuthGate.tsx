'use client';

import { Skeleton, VisuallyHidden } from '@erase/ui';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { copy } from '@/copy/en';
import { ErrorNotice } from './ErrorNotice';
import { isSignedOut, useMe } from '@/lib/session';

/** Shows its children only to a signed-in user. Signed out goes to the sign-in screen; other failures can be retried. */
export function AuthGate({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const signedOut = me.isError && isSignedOut(me.error);

  useEffect(() => {
    if (signedOut) router.replace('/');
  }, [signedOut, router]);

  if (me.isPending || signedOut) {
    return (
      <div role="status" style={{ padding: 'var(--space-6)', display: 'grid', gap: 'var(--space-3)' }}>
        <VisuallyHidden>{copy.common.loading}</VisuallyHidden>
        <Skeleton height={28} width="40%" />
        <Skeleton height={120} />
      </div>
    );
  }
  if (me.isError) {
    return (
      <div style={{ padding: 'var(--space-6)' }}>
        <ErrorNotice error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  return <>{children}</>;
}
