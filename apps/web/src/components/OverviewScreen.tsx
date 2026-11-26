'use client';

import type { CompanyItem, DraftOutcome } from '@erase/contracts';
import { Alert, Button, buttonClass, Card, ProgressBar, Skeleton, VisuallyHidden } from '@erase/ui';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { copy, plural } from '@/copy/en';
import { CompanyRow } from './CompanyRow';
import { DraftOutcomes } from './DraftOutcomes';
import { ErrorNotice } from './ErrorNotice';
import { type NextAction, nextActions, summarise } from '@/lib/tracking';
import { isScanActive, useCompanies, useCreateDrafts, useInboxes, useKeep, useLatestScan, useRequests } from '@/lib/hooks';

type Filter = 'all' | 'likely' | 'possible' | 'kept';

/** The progress of one inbox's scan, shown only while it runs. Polls through useLatestScan. */
function ScanProgress({ inboxId, email }: { inboxId: string; email: string }) {
  const scan = useLatestScan(inboxId).data;
  if (!scan || !isScanActive(scan.status)) return null;
  return <ProgressBar label={`${copy.connect.scanProgress} ${email}`} value={scan.progressPct} detail={`${copy.connect.scanProgress} ${email} · ${plural(scan.foundCount, 'company', 'companies')} so far`} />;
}

/** One thing to do next, with the way to do it. Choosing companies happens on this screen, so it has no link. */
function NextRow({ action }: { action: NextAction }) {
  const n = copy.overview.next;
  const words = ((): { title: string; body: string; link?: string } => {
    switch (action.kind) {
      case 'reconnect':
        return { title: n.reconnect(action.count), body: n.reconnectBody, link: n.reconnectAction };
      case 'drafts':
        return { title: n.drafts(action.count), body: n.draftsBody, link: n.draftsAction };
      case 'followup_drafts':
        return { title: n.followupDrafts(action.count, action.company), body: n.followupDraftsBody, link: n.draftsAction };
      case 'replies':
        return { title: n.replies(action.count, action.company), body: n.repliesBody, link: n.view };
      case 'more_info':
        return { title: n.moreInfo(action.count, action.company), body: n.moreInfoBody, link: n.view };
      case 'followup_due':
        return { title: n.followupDue(action.count, action.company), body: n.followupDueBody, link: n.view };
      case 'connect':
        return { title: n.connect, body: n.connectBody, link: n.connectAction };
      case 'choose':
        return { title: n.choose, body: n.chooseBody };
    }
  })();
  return (
    <li>
      <div className="row-between">
        <div className="grow">
          <div style={{ fontWeight: 600 }}>{words.title}</div>
          <div className="muted">{words.body}</div>
        </div>
        {words.link && action.kind !== 'choose' ? (
          <Link href={action.href} className={buttonClass(action.kind === 'drafts' || action.kind === 'connect' ? 'primary' : 'secondary')}>
            {words.link}
          </Link>
        ) : null}
      </div>
    </li>
  );
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
  // Everything ever sent counts, whatever happened since: a reply does not make a request unsent.
  const summary = summarise(requests.data ?? []);
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
  // Ranked once everything is known, so the list does not reshuffle while it loads.
  const actions = loading || requests.isPending ? [] : nextActions({ inboxes: inboxes.data ?? [], requests: requests.data ?? [], companies: list.length });

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
            <a className="stat-label ui-link" href="#companies">
              {copy.overview.cards.companies}
            </a>
            <span className="stat-value">{loading ? '–' : list.length}</span>
            <span className="muted">{copy.overview.cards.companiesNote}</span>
          </div>
        </Card>
        <Card padded aria-label={copy.overview.cards.control}>
          <div className="stat">
            <Link className="stat-label ui-link" href="/requests">
              {copy.overview.cards.control}
            </Link>
            <span className="stat-value">{requests.isPending ? '–' : summary.sent}</span>
            <span className="muted">{copy.overview.cards.controlNote}</span>
            {summary.reportedErased > 0 ? <span className="muted">{copy.overview.cards.controlErased(summary.reportedErased)}</span> : null}
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
          {actions.map((a) => (
            <NextRow key={a.kind} action={a} />
          ))}
          {!loading && !requests.isPending && actions.length === 0 ? (
            <li>
              <div className="muted">{copy.overview.next.allClear}</div>
            </li>
          ) : null}
        </ul>
      </Card>

      {outcomes ? <DraftOutcomes outcomes={outcomes} companies={list} onDismiss={() => setOutcomes(null)} /> : null}
      {create.isError ? <ErrorNotice error={create.error} /> : null}
      {keep.isError ? <Alert tone="warn">{copy.overview.company.keepFailed}</Alert> : null}

      <div id="companies" />
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
