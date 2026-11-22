'use client';

import type { CompanyItem, DraftOutcome } from '@erase/contracts';
import { Alert, Button, buttonClass, Card, ProgressBar, Skeleton, VisuallyHidden } from '@erase/ui';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { copy, plural } from '@/copy/en';
import { CompanyRow } from './CompanyRow';
import { DraftOutcomes } from './DraftOutcomes';
import { ErrorNotice } from './ErrorNotice';
import { isScanActive, useCompanies, useCreateDrafts, useInboxes, useKeep, useLatestScan, useRequests } from '@/lib/hooks';

type Filter = 'all' | 'likely' | 'possible' | 'kept';

/** The progress of one inbox's scan, shown only while it runs. Polls through useLatestScan. */
function ScanProgress({ inboxId, email }: { inboxId: string; email: string }) {
  const scan = useLatestScan(inboxId).data;
  if (!scan || !isScanActive(scan.status)) return null;
  return <ProgressBar label={`${copy.connect.scanProgress} ${email}`} value={scan.progressPct} detail={`${copy.connect.scanProgress} ${email} · ${plural(scan.foundCount, 'company', 'companies')} so far`} />;
}

/** Overview (PRD F3, Home and Desktop boards): the numbers Phase 1 has, what to do next, and the companies. */
export function OverviewScreen() {
  const companies = useCompanies();
  const inboxes = useInboxes();
  const requests = useRequests();
  const keep = useKeep();
  const create = useCreateDrafts();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>('all');
  const [outcomes, setOutcomes] = useState<DraftOutcome[] | null>(null);

  const list: CompanyItem[] = companies.data ?? [];
  const live = (inboxes.data ?? []).filter((i) => i.status !== 'disconnected');
  const sent = (requests.data ?? []).filter((r) => r.status === 'sent').length;
  const awaiting = (requests.data ?? []).filter((r) => r.status === 'drafted' || r.status === 'approved').length;
  const scanning = live.map((i) => i.id);

  const shown = useMemo(
    () =>
      list.filter((c) => (filter === 'all' ? true : filter === 'likely' ? c.confidence === 'high' : filter === 'possible' ? c.confidence === 'low' : c.kept)),
    [list, filter],
  );
  const chosen = [...selected].filter((id) => list.some((c) => c.id === id && !c.kept && !c.mustKeep && c.openRequest === null));

  function toggle(id: string, next: boolean) {
    setSelected((cur) => {
      const copyOf = new Set(cur);
      if (next) copyOf.add(id);
      else copyOf.delete(id);
      return copyOf;
    });
  }

  function draft() {
    create.mutate(chosen, {
      onSuccess: (results) => {
        setOutcomes(results);
        setSelected(new Set());
      },
    });
  }

  const loading = companies.isPending || inboxes.isPending;

  return (
    <div className="page">
      <div className="page-head">
        <h1>{copy.overview.title}</h1>
        <p className="page-sub">
          {live.length ? `${copy.overview.foundAcross(live.length)} · ` : ''}
          {copy.overview.sub}
        </p>
      </div>

      <div className="cards" aria-label={copy.overview.title}>
        <Card padded aria-label={copy.overview.cards.companies}>
          <div className="stat">
            <span className="stat-label">{copy.overview.cards.companies}</span>
            <span className="stat-value">{loading ? '–' : list.length}</span>
            <span className="muted">{copy.overview.cards.companiesNote}</span>
          </div>
        </Card>
        <Card padded aria-label={copy.overview.cards.control}>
          <div className="stat">
            <span className="stat-label">{copy.overview.cards.control}</span>
            <span className="stat-value">{requests.isPending ? '–' : sent}</span>
            <span className="muted">{copy.overview.cards.controlNote}</span>
          </div>
        </Card>
        {[copy.overview.cards.money, copy.overview.cards.risk].map((label) => (
          <Card padded key={label} aria-label={label}>
            <div className="stat">
              <span className="stat-label">{label}</span>
              <span className="muted" style={{ fontSize: 'var(--fs-17)', fontWeight: 600 }}>
                {copy.overview.cards.notAvailable}
              </span>
            </div>
          </Card>
        ))}
      </div>

      {scanning.length ? (
        <div className="stack">
          {live.map((i) => (
            <ScanProgress key={i.id} inboxId={i.id} email={i.email} />
          ))}
        </div>
      ) : null}

      <Card title={copy.overview.next.title}>
        <ul className="list">
          {live.length === 0 && !inboxes.isPending ? (
            <li>
              <div className="row-between">
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{copy.overview.next.connect}</div>
                  <div className="muted">{copy.overview.next.connectBody}</div>
                </div>
                <Link href="/connect" className={buttonClass('primary')}>
                  {copy.overview.next.connectAction}
                </Link>
              </div>
            </li>
          ) : null}
          {awaiting > 0 ? (
            <li>
              <div className="row-between">
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{copy.overview.next.drafts(awaiting)}</div>
                  <div className="muted">{copy.overview.next.draftsBody}</div>
                </div>
                <Link href="/requests/review" className={buttonClass('primary')}>
                  {copy.overview.next.draftsAction}
                </Link>
              </div>
            </li>
          ) : null}
          {list.length > 0 && awaiting === 0 ? (
            <li>
              <div style={{ fontWeight: 600 }}>{copy.overview.next.choose}</div>
              <div className="muted">{copy.overview.next.chooseBody}</div>
            </li>
          ) : null}
          {live.length > 0 && list.length === 0 && awaiting === 0 && !loading ? (
            <li>
              <div className="muted">{copy.overview.next.allClear}</div>
            </li>
          ) : null}
        </ul>
      </Card>

      {outcomes ? <DraftOutcomes outcomes={outcomes} companies={list} onDismiss={() => setOutcomes(null)} /> : null}
      {create.isError ? <ErrorNotice error={create.error} /> : null}
      {keep.isError ? <Alert tone="warn">{copy.overview.company.keepFailed}</Alert> : null}

      <Card title={copy.overview.list.title}>
        <p className="muted" style={{ marginBottom: 'var(--space-3)' }}>
          {copy.overview.list.note}
        </p>
        <div className="row" role="group" aria-label={copy.overview.list.filterLabel} style={{ marginBottom: 'var(--space-3)' }}>
          {(
            [
              ['all', copy.overview.list.filterAll],
              ['likely', copy.overview.list.filterLikely],
              ['possible', copy.overview.list.filterPossible],
              ['kept', copy.overview.list.filterKept],
            ] as const
          ).map(([value, label]) => (
            <Button key={value} variant={filter === value ? 'primary' : 'secondary'} aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {label}
            </Button>
          ))}
        </div>

        {loading ? (
          <div role="status" className="stack">
            <VisuallyHidden>{copy.common.loading}</VisuallyHidden>
            <Skeleton height={56} />
            <Skeleton height={56} />
            <Skeleton height={56} />
          </div>
        ) : companies.isError ? (
          <ErrorNotice error={companies.error} onRetry={() => void companies.refetch()} />
        ) : list.length === 0 ? (
          <p className="muted">{live.length ? copy.overview.list.emptyScanned : copy.overview.list.empty}</p>
        ) : shown.length === 0 ? (
          <p className="muted">{copy.overview.list.noneMatch}</p>
        ) : (
          <ul className="list">
            {shown.map((c) => (
              <CompanyRow key={c.id} company={c} selected={selected.has(c.id)} onSelect={toggle} onKeep={(id, kept) => keep.mutate({ id, kept })} keepBusy={keep.isPending && keep.variables?.id === c.id} />
            ))}
          </ul>
        )}
      </Card>

      {chosen.length > 0 ? (
        <div className="action-bar" role="region" aria-label={copy.overview.draft.action(chosen.length)}>
          <span className="muted">{copy.overview.draft.note}</span>
          <Button variant="primary" loading={create.isPending} onClick={draft}>
            {create.isPending ? copy.overview.draft.working : copy.overview.draft.action(chosen.length)}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
