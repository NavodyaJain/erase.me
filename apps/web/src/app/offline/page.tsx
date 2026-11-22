import type { Metadata } from 'next';
import { copy } from '@/copy/en';

export const metadata: Metadata = { title: copy.offline.title };

/**
 * Shown by the service worker when there is no network. It is static and shows no personal data: it never calls the
 * API, and what it says is the same for everyone.
 */
export default function OfflinePage() {
  return (
    <main className="centered">
      <div className="narrow">
        <h1>{copy.offline.title}</h1>
        <p>{copy.offline.body}</p>
        <p className="muted">{copy.offline.note}</p>
        <a className="ui-btn ui-btn-primary" href="/">
          {copy.offline.retry}
        </a>
      </div>
    </main>
  );
}
