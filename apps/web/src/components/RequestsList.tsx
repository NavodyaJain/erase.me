'use client';

import type { RequestListItem } from '@erase/contracts';
import { Button, buttonClass, Card, Skeleton, VisuallyHidden } from '@erase/ui';
import Link from 'next/link';
import { useState } from 'react';
import { copy } from '@/copy/en';
import { formatDay } from '@/lib/format';
import { useRequests } from '@/lib/hooks';
import { ErrorNotice } from './ErrorNotice';
import { StatusChip } from './RequestParts';
import { type Filter, matches, summarise } from '@/lib/tracking';

const FILTERS: readonly Filter[] = ['all', 'needs_you', 'waiting', 'erased'];

/** Where a request is on the way from sent to an answer the person recorded. Said in words as well as shown. */
function Progress({ item }: { item: RequestListItem }) {
  if (!item.sentAt) return null;
  const answered = item.status.startsWith('replied_');
  const step = answered ? 3 : item.status === 'reply_received' ? 2 : 1;
  const label = [copy.tracker.progress.sent, copy.tracker.progress.replied, copy.tracker.progress.reported][step - 1] as string;
  return (
    <span className="progress-steps" role="img" aria-label={copy.tracker.progressLabel(label)}>
      {[1, 2, 3].map((n) => (
        <span key={n} className={n <= step ? 'is-done' : undefined} />
      ))}
    </span>
  );
}

/** One line under the company name: what is going on, in words. */
function rowNote(r: RequestListItem): string {
  if (r.followup.state === 'drafted' || r.followup.state === 'approved') return copy.tracker.rowFollowupDraft;
  if (r.followup.canCreate) return copy.tracker.rowFollowupDue;
  const when = r.sentAt ? (r.channel === 'web_form' ? copy.requests.submittedOn : copy.requests.sentOn)(formatDay(r.sentAt)) : formatDay(r.createdAt);
  const waiting = r.status === 'sent' || r.status === 'no_reply';
  if (waiting && r.replies.automaticCount > 0 && r.replies.count === 0) return `${when} · ${copy.tracker.rowAutomatic}`;
  if (r.status === 'sent' && r.dueAt) return `${when} · ${copy.tracker.rowDue(formatDay(r.dueAt))}`;
  return when;
}

export function RequestsList() {
  const list = useRequests();
  const items = list.data ?? [];
  const [filter, setFilter] = useState<Filter>('all');
  const shown = items.filter((r) => matches(r, filter));
  const summary = summarise(items);
  const due = items.find((r) => r.followup.canCreate);
  return (
    <div className="page">
      <div className="page-head">
        <h1>{copy.requests.title}</h1>
        <p className="page-sub">{copy.requests.sub}</p>
      </div>
      {items.length > 0 ? (
        <>
          <dl className="summary" aria-label={copy.tracker.summaryLabel}>
            {(
              [
                [copy.tracker.sent, summary.sent],
                [copy.tracker.replied, summary.replied],
                [copy.tracker.waiting, summary.waiting],
                [copy.tracker.erased, summary.reportedErased],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="muted">{label}</dt>
                <dd className="stat-value">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="muted">{copy.tracker.erasedNote}</p>
        </>
      ) : null}

      {due ? (
        <Card>
          <div className="row-between">
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{copy.tracker.followupBanner(due.company.name)}</div>
              <div className="muted">{copy.tracker.followupBannerBody}</div>
            </div>
            <Link href={`/requests/${due.id}`} className={buttonClass('primary')}>
              {copy.tracker.followupBannerAction}
            </Link>
          </div>
        </Card>
      ) : null}

      <Card>
        {items.length > 0 ? (
          <div className="row" role="group" aria-label={copy.tracker.filterLabel} style={{ marginBottom: 'var(--space-3)' }}>
            {FILTERS.map((f) => (
              <Button key={f} variant={filter === f ? 'primary' : 'secondary'} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {copy.tracker.filters[f]}
              </Button>
            ))}
          </div>
        ) : null}
        {list.isPending ? (
          <div role="status" className="stack">
            <VisuallyHidden>{copy.common.loading}</VisuallyHidden>
            <Skeleton height={40} />
            <Skeleton height={40} />
          </div>
        ) : list.isError ? (
          <ErrorNotice error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          <>
            <p className="muted">{copy.requests.listEmpty}</p>
            <Link href="/overview" className={buttonClass('secondary')}>
              {copy.requests.toOverview}
            </Link>
          </>
        ) : shown.length === 0 ? (
          <p className="muted">{copy.tracker.noneMatch}</p>
        ) : (
          <ul className="list">
            {shown.map((r) => (
              <li key={r.id}>
                <div className="row-between">
                  <div className="grow">
                    <Link className="ui-link" href={`/requests/${r.id}`} style={{ fontWeight: 600 }}>
                      {r.company.name}
                    </Link>
                    <div className="muted">{rowNote(r)}</div>
                  </div>
                  <div className="row-status">
                    <StatusChip status={r.status} />
                    <Progress item={r} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
