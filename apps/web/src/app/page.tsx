import { Suspense } from 'react';
import { SignIn } from '@/components/SignIn';

export default function EntryPage() {
  // useSearchParams needs a Suspense boundary so the page can still be prerendered.
  return (
    <Suspense>
      <SignIn />
    </Suspense>
  );
}
