'use client';

import { buttonClass, Alert, Card, Skeleton, VisuallyHidden } from '@erase/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { copy } from '@/copy/en';
import { authErrorMessage } from '@/copy/errors';
import { ErrorNotice } from './ErrorNotice';
import { ConsentPanel } from './ConsentPanel';
import { useApi } from '@/lib/providers';
import { isStandalone } from '@/lib/pwa';
import { isSignedOut, useMe } from '@/lib/session';

/**
 * The entry route. The API sends the browser back here after Google, with `?auth_error=<reason>` when something went
 * wrong or `?inbox=connected` after an inbox was connected (docs/runbooks/web-origin.md). A signed-in visitor is
 * forwarded; a signed-out one sees the sign-in screen.
 */
export function SignIn() {
  const me = useMe();
  const api = useApi();
  const router = useRouter();
  const params = useSearchParams();
  const authError = params.get('auth_error');
  const signedIn = me.isSuccess;
  const [standalone, setStandalone] = useState(false);

  useEffect(() => setStandalone(isStandalone()), []);
  useEffect(() => {
    if (signedIn) router.replace(params.get('inbox') === 'connected' ? '/connect?inbox=connected' : '/overview');
  }, [signedIn, params, router]);

  if (me.isPending || signedIn) {
    return (
      <div className="centered" role="status">
        <VisuallyHidden>{copy.signIn.checking}</VisuallyHidden>
        <div className="narrow">
          <Skeleton height={32} width="70%" />
          <Skeleton height={140} />
        </div>
      </div>
    );
  }
  if (!isSignedOut(me.error)) {
    return (
      <div className="centered">
        <div className="narrow">
          <ErrorNotice error={me.error} onRetry={() => void me.refetch()} />
        </div>
      </div>
    );
  }

  const url = api.signInUrl();
  return (
    <main className="centered">
      <div className="narrow">
        <img src="/brand/logo-wordmark-light.svg" alt={copy.brand.name} width={128} height={32} />
        <div className="stack">
          <h1>{copy.signIn.title}</h1>
          <p>{copy.signIn.intro}</p>
        </div>
        {authError ? <Alert tone="warn" title={copy.signIn.errorTitle}>{authErrorMessage(authError)}</Alert> : null}
        <a className={buttonClass('primary', true)} href={url}>
          {copy.signIn.button}
        </a>
        <p className="muted">{copy.signIn.shares}</p>
        {standalone ? (
          <Card title={copy.signIn.standaloneTitle} headingLevel={3}>
            <p className="muted">{copy.signIn.standaloneBody}</p>
            <a className="ui-link" href={url} target="_blank" rel="noopener noreferrer">
              {copy.signIn.openInBrowser}
            </a>
          </Card>
        ) : null}
        <ConsentPanel headingLevel={2} />
      </div>
    </main>
  );
}
