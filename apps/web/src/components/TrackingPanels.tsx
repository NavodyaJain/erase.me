'use client';

import type { RequestView } from '@erase/contracts';
import { Alert, Button, Card, Chip } from '@erase/ui';
import { useEffect, useState } from 'react';
import { copy } from '@/copy/en';
import { formatDay } from '@/lib/format';
import { useSetOutcome } from '@/lib/hooks';
import { ErrorNotice } from './ErrorNotice';

/** What was found on the sent conversation: counts and times from headers. Never what a reply says. */
export function RepliesPanel({ view }: { view: RequestView }) {
  const r = view.replies;
  const webForm = view.request.channel === 'web_form';
  return (
    <Card title={copy.replies.title}>
      <div className="stack">
        {webForm ? (
          <p>{copy.replies.webForm}</p>
        ) : r.count > 0 && r.lastAt ? (
          <>
            <p>{copy.replies.found(r.count, formatDay(r.lastAt))}</p>
            <p className="muted">{copy.replies.headersOnly}</p>
            {r.senderMatch === 'other' ? <Alert tone="warn">{copy.replies.otherDomain}</Alert> : null}
          </>
        ) : (
          <p className="muted">{copy.replies.none}</p>
        )}
        {!webForm && r.automaticCount > 0 ? (
          <div className="stack">
            <div>
              <Chip tone="info">{copy.replies.automatic}</Chip>
            </div>
            <p className="muted">{copy.replies.automaticNote(r.automaticCount)}</p>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

const CHOICES = ['confirmed_erased', 'refused', 'needs_more_info', 'no_answer_yet'] as const;
type Choice = (typeof CHOICES)[number];

/** The person's own report of the answer. Always labelled "Reported by you". */
export function OutcomePanel({ id, view }: { id: string; view: RequestView }) {
  const set = useSetOutcome(id);
  const current: Choice = view.outcome?.value ?? 'no_answer_yet';
  const [choice, setChoice] = useState<Choice>(current);
  useEffect(() => setChoice(current), [current]);

  return (
    <Card title={copy.outcome.title}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          set.mutate(choice);
        }}
      >
        {view.outcome?.setByUser ? (
          <p>
            <strong>{copy.outcome.reported(copy.outcome.options[view.outcome.value])}</strong>
            {view.outcome.at ? <span className="muted"> · {copy.outcome.reportedOn(formatDay(view.outcome.at))}</span> : null}
          </p>
        ) : null}
        <p className="muted" id={`outcome-help-${id}`}>
          {copy.outcome.help}
        </p>
        <fieldset className="choices" aria-describedby={`outcome-help-${id}`}>
          <legend className="ui-field-label">{copy.outcome.title}</legend>
          {CHOICES.map((c) => (
            <label key={c} className="choice">
              <input type="radio" name={`outcome-${id}`} value={c} checked={choice === c} onChange={() => setChoice(c)} />
              <span>{copy.outcome.options[c]}</span>
            </label>
          ))}
        </fieldset>
        <div className="row">
          <Button type="submit" variant="secondary" loading={set.isPending} disabled={choice === current}>
            {copy.common.save}
          </Button>
        </div>
        {set.isSuccess && choice === current ? <Alert tone="good">{copy.outcome.saved}</Alert> : null}
        {set.isError ? <ErrorNotice error={set.error} /> : null}
      </form>
    </Card>
  );
}
