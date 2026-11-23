'use client';

import type { RequestView } from '@erase/contracts';
import { Alert, Button, buttonClass, Card, Checkbox, Skeleton, VisuallyHidden } from '@erase/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { copy } from '@/copy/en';
import { ERROR_MESSAGES } from '@/copy/errors';
import { ErrorNotice } from './ErrorNotice';
import { Blockers, DraftText, FakeNotice, StatusChip, UseFormPanel } from './RequestParts';
import { type StepResult, useApproveAndSend, useRequests } from '@/lib/hooks';
import { useApi } from '@/lib/providers';

/**
 * `canSend` from the API is true only once a draft is approved, so it cannot decide who may be chosen here. A draft
 * can be chosen when nothing blocks it (no blockers) and it is still waiting.
 */
const isEligible = (v: RequestView): boolean => v.blockers.length === 0 && (v.request.status === 'drafted' || v.request.status === 'approved');

/**
 * Review and send. The rules this screen enforces (PRD F6, F7):
 * - "Approve and send N" stays disabled until every chosen draft has been opened;
 * - approval carries the hash of the version the person opened, so a changed draft is refused (draft_changed);
 * - a changed draft is shown as changed and is never retried by itself;
 * - each request has its own result and its own Idempotency-Key.
 */
export function ReviewScreen() {
  const api = useApi();
  const list = useRequests();
  const run = useApproveAndSend();
  const [results, setResults] = useState<Map<string, StepResult>>(new Map());
  // A request that was just sent leaves the waiting list, but stays on screen with its result until the page is left.
  const waiting = (list.data ?? []).filter((r) => r.status === 'drafted' || r.status === 'approved' || results.has(r.id));
  const details = useQueries({
    queries: waiting.map((r) => ({ queryKey: ['request', r.id], queryFn: () => api.requests.get(r.id) })),
  });

  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [viewed, setViewed] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);

  const views = new Map<string, RequestView>();
  details.forEach((d, i) => {
    const id = waiting[i]?.id;
    if (id && d.data) views.set(id, d.data);
  });
  const emailItems = [...views.values()].filter((v) => !v.useForm);
  const formItems = [...views.values()].filter((v) => v.useForm);

  /** A draft counts as opened only while the version still on screen is the one that was opened. */
  const isViewed = (v: RequestView): boolean => viewed.get(v.request.id) === v.draft.hash;
  const changedAfterView = (v: RequestView): boolean => viewed.has(v.request.id) && viewed.get(v.request.id) !== v.draft.hash;
  const chosenViews = emailItems.filter((v) => chosen.has(v.request.id) && isEligible(v));
  const allOpened = chosenViews.length > 0 && chosenViews.every(isViewed);

  function toggleOpen(v: RequestView) {
    const id = v.request.id;
    const opening = !open.has(id);
    setOpen((cur) => {
      const next = new Set(cur);
      if (opening) next.add(id);
      else next.delete(id);
      return next;
    });
    if (opening) setViewed((cur) => new Map(cur).set(id, v.draft.hash));
  }

  function toggleChosen(id: string, on: boolean) {
    setChosen((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function approveAndSend(only?: RequestView[]) {
    setBusy(true);
    for (const v of only ?? chosenViews) {
      const id = v.request.id;
      const hash = viewed.get(id);
      if (!hash || hash !== v.draft.hash) continue; // never approve a version the person has not seen
      const result = await run(id, { viewedHash: hash, alreadyApproved: v.request.status === 'approved' && v.approved });
      setResults((cur) => new Map(cur).set(id, result));
      if (result.state === 'stale' || result.state === 'sent') {
        // A changed draft must be read again; a sent one is done. Either way the person has to act again.
        setViewed((cur) => {
          const next = new Map(cur);
          next.delete(id);
          return next;
        });
        setOpen((cur) => {
          const next = new Set(cur);
          next.delete(id);
          return next;
        });
        setChosen((cur) => {
          const next = new Set(cur);
          next.delete(id);
          return next;
        });
      }
    }
    setBusy(false);
  }

  const loading = list.isPending || (waiting.length > 0 && details.some((d) => d.isPending));

  return (
    <div className="page">
      <div className="page-head">
        <h1>{copy.requests.reviewTitle}</h1>
        <p className="page-sub">{copy.requests.reviewSub}</p>
      </div>

      {list.isError ? <ErrorNotice error={list.error} onRetry={() => void list.refetch()} /> : null}
      {loading && !list.isError ? (
        <div role="status" className="stack">
          <VisuallyHidden>{copy.common.loading}</VisuallyHidden>
          <Skeleton height={80} />
          <Skeleton height={80} />
        </div>
      ) : null}

      {!loading && !list.isError && waiting.length === 0 && results.size === 0 ? (
        <Card>
          <p className="muted">{copy.requests.reviewEmpty}</p>
          <Link href="/overview" className={buttonClass('secondary')}>
            {copy.requests.toOverview}
          </Link>
        </Card>
      ) : null}

      {emailItems.length > 0 ? (
        <ul className="list" aria-label={copy.requests.reviewTitle}>
          {emailItems.map((v) => {
            const id = v.request.id;
            const result = results.get(id);
            return (
              <li key={id} data-request-id={id}>
                <Card>
                  <div className="row-between">
                    <Checkbox
                      label={<span style={{ fontWeight: 600 }}>{v.company.name}</span>}
                      aria-label={copy.requests.choose(v.company.name)}
                      checked={chosen.has(id) && isEligible(v)}
                      disabled={!isEligible(v) || busy}
                      onChange={(e) => toggleChosen(id, e.target.checked)}
                    />
                    <div className="chips">
                      <StatusChip status={v.request.status} />
                      <span className="muted">{isViewed(v) ? copy.requests.opened : copy.requests.notOpened}</span>
                    </div>
                  </div>
                  <div className="row" style={{ margin: 'var(--space-2) 0' }}>
                    <Button variant="secondary" aria-expanded={open.has(id)} onClick={() => toggleOpen(v)}>
                      {open.has(id) ? copy.requests.hide : copy.requests.open}
                    </Button>
                    <Link className="ui-link" href={`/requests/${id}`}>
                      {copy.requests.edit}
                    </Link>
                  </div>
                  {changedAfterView(v) ? <Alert tone="warn">{copy.requests.changedSince}</Alert> : null}
                  {open.has(id) ? <DraftText view={v} /> : null}
                  <Blockers blockers={v.blockers} />
                  {result ? <ResultNote result={result} onRetry={() => void approveAndSend([v])} /> : null}
                </Card>
              </li>
            );
          })}
        </ul>
      ) : null}

      {formItems.length > 0 ? (
        <Card title={copy.requests.useFormTitle}>
          <ul className="list">
            {formItems.map((v) => (
              <li key={v.request.id}>
                <div style={{ fontWeight: 600, marginBottom: 'var(--space-2)' }}>{v.company.name}</div>
                <UseFormPanel view={v} />
                <div style={{ marginTop: 'var(--space-2)' }}>
                  <Link className="ui-link" href={`/requests/${v.request.id}`}>
                    {copy.requests.markClosed}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {emailItems.length > 0 ? (
        <div className="action-bar" role="region" aria-label={copy.requests.reviewTitle}>
          <span className="muted">{copy.requests.approveHelp}</span>
          <Button variant="primary" loading={busy} disabled={!allOpened || busy} onClick={() => void approveAndSend()}>
            {busy ? copy.requests.working : copy.requests.approveAndSend(chosenViews.length)}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ResultNote({ result, onRetry }: { result: StepResult; onRetry: () => void }) {
  if (result.state === 'sent') {
    return (
      <div className="stack" style={{ marginTop: 'var(--space-2)' }}>
        <Alert tone="good">{copy.requests.resultSent}</Alert>
        {result.delivery === 'fake' ? <FakeNotice /> : null}
      </div>
    );
  }
  if (result.state === 'stale') {
    return (
      <div style={{ marginTop: 'var(--space-2)' }}>
        <Alert tone="warn" title={copy.requests.staleTitle}>
          {ERROR_MESSAGES.draft_changed}
        </Alert>
      </div>
    );
  }
  if (result.state === 'approved') return <Alert tone="good">{copy.requests.resultApprovedOnly}</Alert>;
  return (
    <div style={{ marginTop: 'var(--space-2)' }}>
      <ErrorNotice error={result.error} onRetry={onRetry} />
    </div>
  );
}
