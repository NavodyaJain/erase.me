import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ConnectScreen } from '@/components/ConnectScreen';
import { copy } from '@/copy/en';

export const metadata: Metadata = { title: copy.connect.title };

export default function ConnectPage() {
  return (
    <Suspense>
      <ConnectScreen />
    </Suspense>
  );
}
