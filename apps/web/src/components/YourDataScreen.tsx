'use client';

import type { AccountDeletion } from '@erase/contracts';
import { Alert, Button, buttonClass, Card, Checkbox, Skeleton, VisuallyHidden } from '@erase/ui';
import Link from 'next/link';
import { useState } from 'react';
import { copy } from '@/copy/en';
import { useDeleteNow, useDeletion, useRequestDeletion, useUndoDeletion } from '@/lib/deletion';
import { formatDay } from '@/lib/format';
import { ErrorNotice } from './ErrorNotice';

export const GOOGLE_PERMISSIONS_URL = 'https://myaccount.google.com/permissions';

/** Google did not confirm removing access for some inboxes: say how many, and where the person can remove it. */
export function GoogleAccessNotice({ notRevoked }: { notRevoked: number }) {
  if (notRevoked <= 0) return null;
  return (
    <Alert tone="warn" title={copy.yourData.googleTitle}>
      <p>{copy.yourData.googleBody(notRevoked)}</p>
      <a className="ui-link" href={GOOGLE_PERMISSIONS_URL} target="_blank" rel="noopener noreferrer">
        {copy.yourData.googleLink}
      </a>
    </Alert>
  );
}

/** What is never touched, said before and after deleting. */
export function UntouchedNotice() {
  return (
    <Alert tone="info" title={copy.yourData.untouchedTitle}>
      <p>{copy.yourData.gmailCopies}</p>
      <p>{copy.yourData.sentRequests}</p>
    </Alert>
  );
}

/** "Your data": what is held, "Delete my data" with its undo period, and the paused state while it is pending. */
export function YourDataScreen() {
  const query = useDeletion();
  const [undone, setUndone] = useState(false);

  return (
    <div className="page">
      <div className="page-head">
        <h1>{copy.yourData.title}</h1>
        <p className="page-sub">{copy.yourData.sub}</p>
      </div>
      {query.isPending ? (
        <div role="status" className="stack">
          <VisuallyHidden>{copy.common.loading}</VisuallyHidden>
          <Skeleton height={120} />
        </div>
      ) : query.isError ? (
        <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.status === 'active' ? (
        <Active undone={undone} onStart={() => setUndone(false)} />
      ) : (
        <Paused deletion={query.data} onUndone={() => setUndone(true)} />
      )}
    </div>
  );
}

function Active({ undone, onStart }: { undone: boolean; onStart: () => void }) {
  const request = useRequestDeletion();
  const [confirming, setConfirming] = useState(false);
  const y = copy.yourData;
  return (
    <>
      {undone ? (
        <Alert tone="good" title={y.undoneTitle}>
          <p>{y.undoneBody}</p>
          <Link href="/connect" className={buttonClass('secondary')}>
            {y.undoneAction}
          </Link>
        </Alert>
      ) : null}
      <Card title={y.holdsTitle}>
        <ul className="stack">
          {y.holds.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Card>
      <Card title={y.deleteTitle}>
        <div className="stack">
          <ul className="stack">
            {y.deleteSteps.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <UntouchedNotice />
          {confirming ? (
            <Alert tone="warn" title={y.confirmTitle}>
              <p>{y.confirmBody}</p>
              <div className="row" style={{ marginTop: 'var(--space-2)' }}>
                <Button
                  variant="primary"
                  loading={request.isPending}
                  onClick={() => {
                    onStart();
                    request.mutate();
                  }}
                >
                  {y.confirmAction}
                </Button>
                <Button variant="secondary" onClick={() => setConfirming(false)}>
                  {copy.common.cancel}
                </Button>
              </div>
            </Alert>
          ) : (
            <div className="row">
              <Button variant="secondary" onClick={() => setConfirming(true)}>
                {y.deleteTitle}
              </Button>
            </div>
          )}
          {request.isError ? <ErrorNotice error={request.error} /> : null}
        </div>
      </Card>
    </>
  );
}

function Paused({ deletion, onUndone }: { deletion: AccountDeletion; onUndone: () => void }) {
  const undo = useUndoDeletion();
  const deleteNow = useDeleteNow();
  const [understood, setUnderstood] = useState(false);
  const y = copy.yourData;
  return (
    <>
      <Card title={deletion.canUndo ? y.pendingTitle : y.finishingTitle}>
        <div className="stack">
          {deletion.canUndo && deletion.deleteAfter ? (
            <>
              <p>
                <strong>{y.deleteOn(formatDay(deletion.deleteAfter))}</strong>
              </p>
              <p>{y.paused}</p>
              <p className="muted">{y.undoNote}</p>
              <div className="row">
                <Button variant="primary" loading={undo.isPending} onClick={() => undo.mutate(undefined, { onSuccess: onUndone })}>
                  {y.undo}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p>{y.finishing}</p>
              <p>{y.paused}</p>
            </>
          )}
          {/* Once the period is over the card above already says so. */}
          {undo.isError && deletion.canUndo ? <ErrorNotice error={undo.error} /> : null}
        </div>
      </Card>
      <GoogleAccessNotice notRevoked={deletion.googleAccess.notRevoked} />
      <UntouchedNotice />
      {deletion.canUndo ? (
        <Card title={y.nowTitle}>
          <div className="stack">
            <p className="muted">{y.nowBody}</p>
            <Checkbox label={y.nowConfirm} checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
            <div className="row">
              <Button variant="secondary" loading={deleteNow.isPending} disabled={!understood} onClick={() => deleteNow.mutate()}>
                {y.nowAction}
              </Button>
            </div>
            {deleteNow.isError ? <ErrorNotice error={deleteNow.error} /> : null}
          </div>
        </Card>
      ) : null}
    </>
  );
}
