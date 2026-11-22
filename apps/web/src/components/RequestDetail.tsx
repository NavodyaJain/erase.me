'use client';

import { isStaleDraft } from '@erase/api-client';
import type { RequestView } from '@erase/contracts';
import { Alert, Button, Card, Skeleton, TextArea, TextField, VisuallyHidden } from '@erase/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { copy } from '@/copy/en';
import { ERROR_MESSAGES } from '@/copy/errors';
import { formatDay } from '@/lib/format';
import { type StepResult, useApproveAndSend, useCloseRequest, useEditDraft, useRequest } from '@/lib/hooks';
import { ErrorNotice } from './ErrorNotice';
import { Blockers, DraftText, FakeNotice, SentDates, StatusChip, UseFormPanel } from './RequestParts';

/** One request: read or edit the draft, approve and send it, see what happened, or close it. */
export function RequestDetail({ id }: { id: string }) {
  const query = useRequest(id);
  if (query.isPending) {
    return (
      <div className="page" role="status">
        <VisuallyHidden>{copy.common.loading}</VisuallyHidden>
        <Skeleton height={32} width="50%" />
        <Skeleton height={200} />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="page">
        <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />
        <Link className="ui-link" href="/requests">
          {copy.requests.title}
        </Link>
      </div>
    );
  }
  return <Loaded id={id} view={query.data} />;
}

function Loaded({ id, view }: { id: string; view: RequestView }) {
  const edit = useEditDraft(id);
  const close = useCloseRequest(id);
  const run = useApproveAndSend();
  const [subject, setSubject] = useState(view.draft.subject);
  const [body, setBody] = useState(view.draft.body);
  const [result, setResult] = useState<StepResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  // The hash of the version the person is looking at. Approval always uses this, never a newer one.
  const [seenHash, setSeenHash] = useState(view.draft.hash);
  const [justSaved, setJustSaved] = useState(false);

  const editable = view.request.status === 'drafted' || view.request.status === 'approved';
  const dirty = subject !== view.draft.subject || body !== view.draft.body;

  // When the server's draft changes (after saving or a refresh), show the new text. Approval stays locked until it is read.
  useEffect(() => {
    setSubject(view.draft.subject);
    setBody(view.draft.body);
  }, [view.draft.hash, view.draft.subject, view.draft.body]);

  const unread = seenHash !== view.draft.hash;
  const changedElsewhere = unread && !justSaved;

  function save() {
    setJustSaved(false);
    edit.mutate(
      { baseHash: view.draft.hash, subject, body },
      {
        onSuccess: () => {
          setJustSaved(true);
        },
      },
    );
  }

  async function approveAndSend() {
    setBusy(true);
    const r = await run(id, { viewedHash: seenHash, alreadyApproved: view.request.status === 'approved' && view.approved && seenHash === view.draft.hash });
    setResult(r);
    setBusy(false);
  }

  return (
    <div className="page">
      <div className="page-head">
        <Link className="ui-link" href="/requests/review">
          {copy.requests.reviewTitle}
        </Link>
        <h1>{view.company.name}</h1>
        <div className="chips">
          <StatusChip status={view.request.status} />
        </div>
        <SentDates view={view} />
      </div>

      {view.useForm ? <UseFormPanel view={view} /> : null}
      <Blockers blockers={view.blockers} />

      <Card title={copy.requests.detailsTitle}>
        {editable && !view.useForm ? (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <p className="muted">{copy.requests.editHint}</p>
            <div>
              <div className="muted">{copy.requests.to}</div>
              <div style={{ overflowWrap: 'anywhere' }}>{view.draft.to}</div>
            </div>
            <TextField label={copy.requests.subject} value={subject} onChange={(e) => setSubject(e.target.value)} />
            <TextArea label={copy.requests.message} rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
            <div className="row">
              <Button type="submit" variant="secondary" loading={edit.isPending} disabled={!dirty}>
                {copy.requests.save}
              </Button>
            </div>
            {edit.isError ? (
              isStaleDraft(edit.error) ? (
                <Alert tone="warn" title={copy.requests.staleTitle}>
                  {ERROR_MESSAGES.draft_changed}
                </Alert>
              ) : (
                <ErrorNotice error={edit.error} />
              )
            ) : null}
            {justSaved && !dirty ? <Alert tone="good">{copy.requests.saved}</Alert> : null}
          </form>
        ) : (
          <DraftText view={view} />
        )}
      </Card>

      {changedElsewhere ? (
        <Alert tone="warn" title={copy.requests.staleTitle}>
          {copy.requests.changedSince}{' '}
          <Button variant="secondary" onClick={() => setSeenHash(view.draft.hash)}>
            {copy.requests.open}
          </Button>
        </Alert>
      ) : null}

      {editable && !view.useForm ? (
        <Card>
          <div className="stack">
            <p className="muted">{copy.requests.approveHelp}</p>
            <div className="row">
              <Button
                variant="primary"
                loading={busy}
                disabled={busy || dirty || unread || !view.canSend}
                onClick={() => void approveAndSend()}
              >
                {busy ? copy.requests.working : copy.requests.sendConfirm}
              </Button>
            </div>
            {unread && justSaved ? (
              <Button variant="secondary" onClick={() => setSeenHash(view.draft.hash)}>
                {copy.requests.open}
              </Button>
            ) : null}
            {result?.state === 'sent' ? (
              <>
                <Alert tone="good">{copy.requests.resultSent}</Alert>
                {result.delivery === 'fake' ? <FakeNotice /> : null}
              </>
            ) : result?.state === 'stale' ? (
              <Alert tone="warn" title={copy.requests.staleTitle}>
                {ERROR_MESSAGES.draft_changed}
              </Alert>
            ) : result?.state === 'error' ? (
              <ErrorNotice error={result.error} onRetry={() => void approveAndSend()} />
            ) : null}
          </div>
        </Card>
      ) : null}

      {view.events.some((e) => e.payload?.delivery === 'fake') ? <FakeNotice /> : null}

      {view.request.status !== 'closed' && view.request.status !== 'sent' ? (
        <Card>
          {confirmClose ? (
            <Alert tone="warn" title={copy.requests.markClosed}>
              <p>{copy.requests.closeBody}</p>
              <div className="row" style={{ marginTop: 'var(--space-2)' }}>
                <Button variant="primary" loading={close.isPending} onClick={() => close.mutate(undefined, { onSuccess: () => setConfirmClose(false) })}>
                  {copy.requests.closeConfirm}
                </Button>
                <Button variant="secondary" onClick={() => setConfirmClose(false)}>
                  {copy.common.cancel}
                </Button>
              </div>
            </Alert>
          ) : (
            <Button variant="quiet" onClick={() => setConfirmClose(true)}>
              {copy.requests.markClosed}
            </Button>
          )}
          {close.isError ? <ErrorNotice error={close.error} /> : null}
        </Card>
      ) : null}
      {view.request.status === 'closed' ? <Alert tone="info">{copy.requests.closed}</Alert> : null}

      <Card title={copy.requests.activity}>
        <ol className="list" style={{ listStyle: 'none', padding: 0 }}>
          {view.events.map((e) => (
            <li key={`${e.type}-${e.at}`}>
              <span style={{ fontWeight: 600 }}>{copy.labels.event[e.type as keyof typeof copy.labels.event] ?? e.type}</span>
              <span className="muted"> · {formatDay(e.at)}</span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
