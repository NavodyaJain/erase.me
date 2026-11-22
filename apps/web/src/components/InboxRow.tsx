'use client';

import type { Inbox } from '@erase/contracts';
import { Alert, Button, Chip, ProgressBar } from '@erase/ui';
import { useState } from 'react';
import { copy, plural } from '@/copy/en';
import { ErrorNotice } from './ErrorNotice';
import { isScanActive, useDisconnectInbox, useLatestScan, useStartScan } from '@/lib/hooks';

/** One connected inbox: its scan (with progress, polled while running), scan and disconnect actions. */
export function InboxRow({ inbox }: { inbox: Inbox }) {
  const scan = useLatestScan(inbox.id);
  const startScan = useStartScan();
  const disconnect = useDisconnectInbox();
  const [confirming, setConfirming] = useState(false);
  const latest = scan.data;
  const active = isScanActive(latest?.status);
  const connected = inbox.status === 'connected';

  return (
    <li>
      <div className="row-between">
        <div className="grow">
          <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{inbox.email}</div>
          <div className="chips" style={{ marginTop: 'var(--space-1)' }}>
            <Chip tone={connected ? 'good' : inbox.status === 'error' ? 'warn' : 'neutral'}>{copy.labels.inboxStatus[inbox.status]}</Chip>
            {latest?.status === 'done' ? <Chip tone="info">{`${copy.labels.scanStatus.done} · ${plural(latest.foundCount, 'company', 'companies')}`}</Chip> : null}
            {latest?.status === 'failed' ? <Chip tone="warn">{copy.labels.scanStatus.failed}</Chip> : null}
          </div>
        </div>
        <div className="row">
          {connected ? (
            <Button variant="secondary" loading={startScan.isPending || active} onClick={() => startScan.mutate(inbox.id)}>
              {latest?.status === 'done' ? copy.connect.scanAgain : copy.connect.scan}
            </Button>
          ) : null}
          <Button variant="quiet" onClick={() => setConfirming(true)} aria-label={`${copy.connect.disconnect} ${inbox.email}`}>
            {copy.connect.disconnect}
          </Button>
        </div>
      </div>

      {active && latest ? (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <ProgressBar label={`${copy.connect.scanProgress} ${inbox.email}`} value={latest.progressPct} detail={`${copy.connect.scanProgress} · ${plural(latest.foundCount, 'company', 'companies')} so far`} />
        </div>
      ) : null}

      {latest?.status === 'failed' ? (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <Alert tone="warn">{latest.errorCode === 'gmail_auth' ? copy.connect.needsReconnect : copy.connect.scanFailed}</Alert>
        </div>
      ) : null}
      {inbox.status === 'error' ? (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <Alert tone="warn">{copy.connect.needsReconnect}</Alert>
        </div>
      ) : null}

      {startScan.isError ? (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <ErrorNotice error={startScan.error} />
        </div>
      ) : null}

      {confirming ? (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <Alert tone="warn" title={copy.connect.disconnectTitle}>
            <p>{copy.connect.disconnectBody}</p>
            <div className="row" style={{ marginTop: 'var(--space-2)' }}>
              <Button
                variant="primary"
                loading={disconnect.isPending}
                onClick={() => disconnect.mutate(inbox.id, { onSuccess: () => setConfirming(false) })}
              >
                {copy.connect.disconnectConfirm}
              </Button>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                {copy.common.cancel}
              </Button>
            </div>
          </Alert>
          {disconnect.isError ? <ErrorNotice error={disconnect.error} /> : null}
        </div>
      ) : null}
      {disconnect.isSuccess && !disconnect.data.revokedAtGoogle ? (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <Alert tone="warn">{copy.connect.notRevoked}</Alert>
        </div>
      ) : null}
    </li>
  );
}
