'use client';

import { Alert, Button, buttonClass, Card, Skeleton, VisuallyHidden } from '@erase/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { copy } from '@/copy/en';
import { ConsentPanel } from './ConsentPanel';
import { ErrorNotice } from './ErrorNotice';
import { InboxRow } from './InboxRow';
import { useInboxes, useStartConnect, useStartScan } from '@/lib/hooks';

/** Connect inboxes (PRD F1, F2): the inbox list with scan progress, the plain consent panel, and connect and disconnect. */
export function ConnectScreen() {
  const inboxes = useInboxes();
  const startConnect = useStartConnect();
  const startScan = useStartScan();
  const params = useSearchParams();
  const justConnected = params.get('inbox') === 'connected';
  const autoStarted = useRef(new Set<string>());

  // Right after Google sends the person back, scan any inbox that has never been scanned (once each).
  useEffect(() => {
    if (!justConnected || !inboxes.data) return;
    for (const inbox of inboxes.data) {
      if (inbox.status === 'connected' && inbox.lastScanAt === null && !autoStarted.current.has(inbox.id)) {
        autoStarted.current.add(inbox.id);
        startScan.mutate(inbox.id);
      }
    }
    // startScan.mutate is stable and the ref guards repeats, so only the inputs below matter.
  }, [justConnected, inboxes.data]);

  const list = inboxes.data ?? [];
  const live = list.filter((i) => i.status !== 'disconnected');
  const canContinue = live.some((i) => i.status === 'connected');

  function connect() {
    startConnect.mutate(undefined, { onSuccess: (url) => window.location.assign(url) });
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>{copy.connect.title}</h1>
        <p className="page-sub">{copy.connect.sub}</p>
      </div>

      {justConnected ? <Alert tone="good">{copy.connect.connected}</Alert> : null}

      <Card title={copy.connect.listTitle} aria-label={copy.connect.listTitle}>
        {inboxes.isPending ? (
          <div role="status" className="stack">
            <VisuallyHidden>{copy.common.loading}</VisuallyHidden>
            <Skeleton height={20} width="60%" />
            <Skeleton height={20} width="45%" />
          </div>
        ) : inboxes.isError ? (
          <ErrorNotice error={inboxes.error} onRetry={() => void inboxes.refetch()} />
        ) : live.length === 0 ? (
          <p className="muted">{copy.connect.empty}</p>
        ) : (
          <ul className="list">
            {live.map((inbox) => (
              <InboxRow key={inbox.id} inbox={inbox} />
            ))}
          </ul>
        )}
      </Card>

      <ConsentPanel />

      <div className="stack">
        {startConnect.isError ? <ErrorNotice error={startConnect.error} /> : null}
        {startScan.isError ? <ErrorNotice error={startScan.error} /> : null}
        <div className="row">
          <Button variant="primary" loading={startConnect.isPending || startConnect.isSuccess} onClick={connect}>
            {startConnect.isPending || startConnect.isSuccess ? copy.connect.redirecting : live.length ? copy.connect.addAnother : copy.connect.add}
          </Button>
          {canContinue ? (
            <Link href="/overview" className={buttonClass('secondary')}>
              {copy.connect.seeWhatWeFound}
            </Link>
          ) : null}
        </div>
      </div>

      <Card title={copy.connect.howTitle} headingLevel={2}>
        <ol className="stack" style={{ margin: 0, paddingLeft: 'var(--space-5)' }}>
          {copy.connect.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
