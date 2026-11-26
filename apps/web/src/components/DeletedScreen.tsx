'use client';

import { buttonClass } from '@erase/ui';
import Link from 'next/link';
import { copy } from '@/copy/en';
import { useDeletedNotice } from '@/lib/deletion';
import { GoogleAccessNotice, UntouchedNotice } from './YourDataScreen';

/**
 * Shown, signed out, after "Delete now". It repeats what was not touched and, if Google did not confirm removing access,
 * how to remove it. Opened on its own (after a reload) it knows nothing about anyone, and says only that.
 */
export function DeletedScreen() {
  const { notice } = useDeletedNotice();
  const y = copy.yourData;
  const title = !notice ? y.signedOutTitle : notice.status === 'deleted' ? y.deletedTitle : y.finishingTitle;
  return (
    <main className="centered">
      <div className="narrow">
        <img src="/brand/logo-wordmark-light.svg" alt={copy.brand.name} width={128} height={32} />
        <div className="stack">
          <h1>{title}</h1>
          <p>{y.signedOut}</p>
        </div>
        {notice ? <GoogleAccessNotice notRevoked={notice.googleAccess.notRevoked} /> : null}
        <UntouchedNotice />
        <Link href="/" className={buttonClass('secondary', true)}>
          {y.home}
        </Link>
      </div>
    </main>
  );
}
