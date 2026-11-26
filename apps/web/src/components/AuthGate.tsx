'use client';

import { Skeleton, VisuallyHidden } from '@erase/ui';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { copy } from '@/copy/en';
import { ErrorNotice } from './ErrorNotice';
import { isPaused, useDeletedNotice, useDeletion, useDeletionWatch } from '@/lib/deletion';
import { isSignedOut, useMe } from '@/lib/session';

/**
 * Shows its children only to a signed-in user. Signed out goes to the sign-in screen; other failures can be retried.
 * Someone whose deletion is pending is sent to "Your data", the only screen that works for them then.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const signedOut = me.isError && isSignedOut(me.error);
  const pathname = usePathname();
  const { notice } = useDeletedNotice();
  useDeletionWatch();
  const deletion = useDeletion(me.isSuccess);
  const elsewhere = isPaused(deletion.data) && pathname !== '/your-data';

  useEffect(() => {
    if (signedOut) router.replace(notice ? '/deleted' : '/');
  }, [signedOut, notice, router]);
  useEffect(() => {
    if (elsewhere) router.replace('/your-data');
  }, [elsewhere, router]);

  // A failure to read where deletion stands does not lock anyone out: the API refuses what a paused account may not do.
  if (me.isPending || signedOut || (me.isSuccess && deletion.isPending) || elsewhere) {
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
