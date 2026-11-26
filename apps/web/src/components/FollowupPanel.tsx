'use client';

import { isStaleDraft } from '@erase/api-client';
import type { RequestView } from '@erase/contracts';
import { Alert, Button, Card, CopyButton, TextArea, TextField } from '@erase/ui';
import { useEffect, useState } from 'react';
import { copy } from '@/copy/en';
import { ERROR_MESSAGES } from '@/copy/errors';
import { formatDay } from '@/lib/format';
import { type StepResult, useApproveAndSendFollowup, useCreateFollowup, useEditFollowup, useMarkFollowupSubmitted } from '@/lib/hooks';
import { ErrorNotice } from './ErrorNotice';
import { Blockers, FakeNotice } from './RequestParts';

type Followup = RequestView['followup'];
type FollowupDraft = NonNullable<Followup['draft']>;

/** The one polite follow-up to a request with no reply: offered when due, read and approved by the person, or copied into a form. */
export function FollowupPanel({ id, view }: { id: string; view: RequestView }) {
  const f = view.followup;
  const create = useCreateFollowup(id);
  const run = useApproveAndSendFollowup();
  // Kept here, so the result of a send stays on screen when the panel changes to "sent".
  const [result, setResult] = useState<StepResult | null>(null);

  if (f.state === 'none') return null;
  const open = f.state === 'drafted' || f.state === 'approved';

  return (
    <Card title={copy.followup.title}>
      <div className="stack">
        {f.state === 'not_due' && f.dueAt ? <p className="muted">{copy.followup.notDue(formatDay(f.dueAt))}</p> : null}

        {f.state === 'due' ? (
          <>
            <p>{f.canCreate ? copy.followup.due : copy.followup.dueBlocked}</p>
            <Blockers blockers={f.blockers} />
            {f.canCreate ? (
              <>
                <p className="muted">{copy.followup.createHelp}</p>
                <div className="row">
                  <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
                    {copy.followup.create}
                  </Button>
                </div>
              </>
            ) : null}
            {create.isError ? <ErrorNotice error={create.error} /> : null}
          </>
        ) : null}

        {open && f.draft ? <OpenFollowup key={f.sequence} id={id} view={view} draft={f.draft} run={run} result={result} setResult={setResult} /> : null}

        {(f.state === 'sent' || f.state === 'submitted') && f.sentAt ? (
          <>
            <p>
              <strong>{f.state === 'sent' ? copy.followup.sentOn(formatDay(f.sentAt)) : copy.followup.submittedOn(formatDay(f.sentAt))}</strong>
            </p>
            {result?.state === 'sent' ? (
              <>
                <Alert tone="good">{copy.followup.resultSent}</Alert>
                {result.delivery === 'fake' ? <FakeNotice /> : null}
              </>
            ) : null}
            {f.draft ? <ReadOnly draft={f.draft} /> : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}

function ReadOnly({ draft }: { draft: FollowupDraft }) {
  return (
    <dl className="stack" style={{ margin: 0 }}>
      <div>
        <dt className="muted">{copy.requests.to}</dt>
        <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{draft.to}</dd>
      </div>
      <div>
        <dt className="muted">{copy.requests.subject}</dt>
        <dd style={{ margin: 0 }}>{draft.subject}</dd>
      </div>
      <div>
        <dt className="muted">{copy.requests.message}</dt>
        <dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{draft.body}</dd>
      </div>
    </dl>
  );
}

function OpenFollowup(props: {
  id: string;
  view: RequestView;
  draft: FollowupDraft;
  run: ReturnType<typeof useApproveAndSendFollowup>;
  result: StepResult | null;
  setResult: (r: StepResult | null) => void;
}) {
  const { id, view, draft, run, result, setResult } = props;
  const f = view.followup;
  const form = view.request.channel === 'web_form';
  const edit = useEditFollowup(id);
  const submitted = useMarkFollowupSubmitted(id);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  // The version the person is looking at. Approval and "submitted" always use this, never a newer one.
  const [seenHash, setSeenHash] = useState(draft.hash);
  const [justSaved, setJustSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSubject(draft.subject);
    setBody(draft.body);
  }, [draft.hash, draft.subject, draft.body]);

  const dirty = subject !== draft.subject || body !== draft.body;
  const unread = seenHash !== draft.hash;
  const locked = dirty || unread;

  async function approveAndSend() {
    setBusy(true);
    setResult(null);
    setResult(await run(id, { viewedHash: seenHash, alreadyApproved: f.approved && seenHash === draft.hash }));
    setBusy(false);
  }

  return (
    <>
      <p className="muted">{form ? copy.followup.formBody : copy.followup.draftHelp}</p>
      <Blockers blockers={f.blockers} />
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setJustSaved(false);
          edit.mutate({ baseHash: draft.hash, subject, body }, { onSuccess: () => setJustSaved(true) });
        }}
      >
        <p className="muted">{copy.followup.editHint}</p>
        <div>
          <div className="muted">{form ? copy.requests.useFormTitle : copy.requests.to}</div>
          <div style={{ overflowWrap: 'anywhere' }}>{draft.to}</div>
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
        {justSaved && !dirty ? <Alert tone="good">{copy.followup.saved}</Alert> : null}
      </form>

      {unread ? (
        <Alert tone="warn" title={copy.requests.staleTitle}>
          {justSaved ? null : <p>{copy.followup.changed}</p>}
          <Button variant="secondary" onClick={() => setSeenHash(draft.hash)}>
            {copy.followup.open}
          </Button>
        </Alert>
      ) : null}

      {form ? (
        <div className="row">
          <a className="ui-link" href={view.contact.formUrl ?? draft.to} target="_blank" rel="noopener noreferrer">
            {copy.requests.useFormOpen}
          </a>
          <CopyButton text={`${draft.subject}\n\n${draft.body}`} label={copy.requests.copyDraft} copiedLabel={copy.requests.copied} />
          <Button variant="primary" loading={submitted.isPending} disabled={locked || !f.canMarkSubmitted} onClick={() => submitted.mutate(seenHash)}>
            {copy.requests.submitAction}
          </Button>
        </div>
      ) : (
        <div className="row">
          <Button
            variant="primary"
            loading={busy}
            // An approved follow-up that the API will not send stays disabled; a drafted one is blocked by its listed reasons.
            disabled={busy || locked || f.blockers.length > 0}
            onClick={() => void approveAndSend()}
          >
            {busy ? copy.requests.working : copy.followup.approveAndSend}
          </Button>
        </div>
      )}
      {submitted.isError ? <ErrorNotice error={submitted.error} /> : null}
      {result?.state === 'stale' ? (
        <Alert tone="warn" title={copy.requests.staleTitle}>
          {ERROR_MESSAGES.draft_changed}
        </Alert>
      ) : result?.state === 'error' ? (
        <ErrorNotice error={result.error} onRetry={() => void approveAndSend()} />
      ) : null}
    </>
  );
}
