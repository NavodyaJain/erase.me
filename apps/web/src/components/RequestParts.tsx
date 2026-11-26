'use client';

import type { RequestView } from '@erase/contracts';
import { Alert, Button, Chip, CopyButton } from '@erase/ui';
import { copy } from '@/copy/en';
import { ERROR_MESSAGES } from '@/copy/errors';
import { formatDay } from '@/lib/format';

type Blocker = RequestView['blockers'][number];

/** The app's own sentence for a blocker. The server's `message` is not shown. */
export function blockerText(code: string): string {
  return (ERROR_MESSAGES as Record<string, string>)[code] ?? ERROR_MESSAGES.not_found;
}

/** Why a draft cannot go yet. An unfinished line gets its own wording and points at editing, with no shortcut. */
export function Blockers({ blockers }: { blockers: Blocker[] }) {
  if (!blockers.length) return null;
  return (
    <div className="stack" data-testid="blockers">
      {blockers.map((b) =>
        b.code === 'draft_unsafe' && b.findings?.includes('open_placeholder') ? (
          <Alert key={b.code} tone="warn" title={copy.requests.placeholderTitle}>
            {copy.requests.placeholderBody}
          </Alert>
        ) : (
          <Alert key={b.code} tone={b.code === 'send_disabled' || b.code === 'real_send_blocked' ? 'info' : 'warn'} title={copy.requests.blockedTitle}>
            {blockerText(b.code)}
          </Alert>
        ),
      )}
    </div>
  );
}

/** The recipient, subject and message exactly as they would be sent. */
export function DraftText({ view }: { view: RequestView }) {
  const d = view.draft;
  return (
    <dl className="stack" style={{ margin: 0 }}>
      <div>
        <dt className="muted">{view.useForm ? copy.requests.useFormTitle : copy.requests.to}</dt>
        <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{d.to}</dd>
      </div>
      <div>
        <dt className="muted">{copy.requests.subject}</dt>
        <dd style={{ margin: 0 }}>{d.subject}</dd>
      </div>
      <div>
        <dt className="muted">{copy.requests.message}</dt>
        <dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{d.body}</dd>
      </div>
    </dl>
  );
}

/** For a company that takes requests through a form: the form link and a copy button. Nothing is sent from here. */
export function UseFormPanel({ view }: { view: RequestView }) {
  const url = view.contact.formUrl ?? view.draft.to;
  return (
    <Alert tone="info" title={copy.requests.useFormTitle}>
      <p>{copy.requests.useFormBody}</p>
      <div className="row" style={{ marginTop: 'var(--space-2)' }}>
        <a className="ui-link" href={url} target="_blank" rel="noopener noreferrer">
          {copy.requests.useFormOpen}
        </a>
        <CopyButton text={`${view.draft.subject}\n\n${view.draft.body}`} label={copy.requests.copyDraft} copiedLabel={copy.requests.copied} />
      </div>
    </Alert>
  );
}

export function StatusChip({ status }: { status: string }) {
  const label = copy.labels.requestStatus[status as keyof typeof copy.labels.requestStatus] ?? status;
  const tone = status === 'sent' || status === 'replied_deleted' ? 'good' : status === 'bounced' || status === 'replied_refused' ? 'warn' : 'info';
  return <Chip tone={tone}>{label}</Chip>;
}

export function FakeNotice() {
  return (
    <Alert tone="info" title={copy.requests.sendingDevTitle}>
      {copy.requests.fakeNotice}
    </Alert>
  );
}

export function SentDates({ view }: { view: RequestView }) {
  const r = view.request;
  if (!r.sentAt) return null;
  return (
    <p className="muted">
      {(r.channel === 'web_form' ? copy.requests.submittedOn : copy.requests.sentOn)(formatDay(r.sentAt))}
      {r.dueAt ? ` · ${copy.requests.dueOn(formatDay(r.dueAt))}` : ''}
    </p>
  );
}

export { Button };
