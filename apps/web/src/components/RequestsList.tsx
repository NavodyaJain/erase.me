'use client';

import { buttonClass, Card, Skeleton, VisuallyHidden } from '@erase/ui';
import Link from 'next/link';
import { copy } from '@/copy/en';
import { formatDay } from '@/lib/format';
import { useRequests } from '@/lib/hooks';
import { ErrorNotice } from './ErrorNotice';
import { StatusChip } from './RequestParts';

export function RequestsList() {
  const list = useRequests();
  const items = list.data ?? [];
  return (
    <div className="page">
      <div className="page-head">
        <h1>{copy.requests.title}</h1>
        <p className="page-sub">{copy.requests.sub}</p>
      </div>
      <Card>
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
        ) : (
          <ul className="list">
            {items.map((r) => (
              <li key={r.id}>
                <div className="row-between">
                  <div className="grow">
                    <Link className="ui-link" href={`/requests/${r.id}`} style={{ fontWeight: 600 }}>
                      {r.company.name}
                    </Link>
                    <div className="muted">{r.sentAt ? copy.requests.sentOn(formatDay(r.sentAt)) : formatDay(r.createdAt)}</div>
                  </div>
                  <StatusChip status={r.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
