'use client';

import { isStaleDraft } from '@erase/api-client';
import type { RequestView } from '@erase/contracts';
import { Alert, Button, Card, Skeleton, TextArea, TextField, VisuallyHidden } from '@erase/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { copy } from '@/copy/en';
import { ERROR_MESSAGES } from '@/copy/errors';
import { formatDay } from '@/lib/format';
import { type StepResult, useApproveAndSend, useCloseRequest, useEditDraft, useMarkSubmitted, useRequest } from '@/lib/hooks';
import { canClose, isUnsent } from '@/lib/tracking';
import { ErrorNotice } from './ErrorNotice';
import { FollowupPanel } from './FollowupPanel';
import { Blockers, DraftText, FakeNotice, SentDates, StatusChip, UseFormPanel } from './RequestParts';
import { OutcomePanel, RepliesPanel } from './TrackingPanels';

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

/** The words for one entry of the history. Some event types mean different things, which their payload says. */
export function eventLabel(e: RequestView['events'][number]): string {
  if (e.type === 'reply_label' && e.payload.to === 'no_reply') return copy.labels.eventNoReply;
  if (e.type === 'outcome_set') {
    const answer = copy.outcome.options[e.payload.outcome as keyof typeof copy.outcome.options];
    if (answer) return copy.outcome.reported(answer);
  }
  if (e.type === 'submitted' && e.payload.followup !== undefined) return copy.labels.eventFollowupSubmitted;
  if (e.type === 'edited' && e.payload.followup !== undefined) return copy.labels.eventFollowupEdited;
  return copy.labels.event[e.type as keyof typeof copy.labels.event] ?? e.type;
}

function Loaded({ id, view }: { id: string; view: RequestView }) {
  const edit = useEditDraft(id);
  const close = useCloseRequest(id);
  const run = useApproveAndSend();
  const submitted = useMarkSubmitted(id);
  const [subject, setSubject] = useState(view.draft.subject);
  const [body, setBody] = useState(view.draft.body);
  const [result, setResult] = useState<StepResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  // The hash of the version the person is looking at. Approval always uses this, never a newer one.
  const [seenHash, setSeenHash] = useState(view.draft.hash);
  const [justSaved, setJustSaved] = useState(false);

  const editable = isUnsent(view.request.status);
  // For a web form the form itself is the way to send, so that blocker is not shown as something wrong.
  const blockers = view.useForm ? view.blockers.filter((b) => b.code !== 'use_form') : view.blockers;
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

      {view.useForm && editable ? <UseFormPanel view={view} /> : null}
      {editable ? <Blockers blockers={blockers} /> : null}

      {view.canSetOutcome ? (
        <>
          <RepliesPanel view={view} />
          <OutcomePanel id={id} view={view} />
        </>
      ) : null}
      <FollowupPanel id={id} view={view} />

      <Card title={copy.requests.detailsTitle}>
        {editable ? (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <p className="muted">{copy.requests.editHint}</p>
            <div>
              <div className="muted">{view.useForm ? copy.requests.useFormTitle : copy.requests.to}</div>
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

      {editable && view.useForm ? (
        <Card title={copy.requests.submitTitle}>
          <div className="stack">
            <p className="muted">{copy.requests.submitHelp}</p>
            {unread ? <p>{copy.requests.submitChanged}</p> : null}
            <div className="row">
              {unread ? (
                <Button variant="secondary" onClick={() => setSeenHash(view.draft.hash)}>
                  {copy.requests.open}
                </Button>
              ) : null}
              <Button variant="primary" loading={submitted.isPending} disabled={dirty || unread || !view.canMarkSubmitted} onClick={() => submitted.mutate(seenHash)}>
                {copy.requests.submitAction}
              </Button>
            </div>
            {submitted.isError ? <ErrorNotice error={submitted.error} /> : null}
          </div>
        </Card>
      ) : null}

      {editable && !view.useForm ? (
        <Card>
          <div className="stack">
            <p className="muted">{copy.requests.approveHelp}</p>
            <div className="row">
              <Button
                variant="primary"
                loading={busy}
                disabled={busy || dirty || unread || view.blockers.length > 0}
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

      {canClose(view.request.status) ? (
        <Card>
          {confirmClose ? (
            <Alert tone="warn" title={copy.requests.markClosed}>
              <p>{editable ? copy.requests.closeBody : copy.requests.closeTrackedBody}</p>
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
              <span style={{ fontWeight: 600 }}>{eventLabel(e)}</span>
              <span className="muted"> · {formatDay(e.at)}</span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
