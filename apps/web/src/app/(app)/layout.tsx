import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';
import { AuthGate } from '@/components/AuthGate';

/** Everything signed-in lives here: the gate first, then the frame. */
export default function SignedInLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <AppShell>{children}</AppShell>
    </AuthGate>
  );
}
