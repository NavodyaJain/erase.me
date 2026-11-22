'use client';

import type { CompanyItem, DraftOutcome } from '@erase/contracts';
import { Alert, Button, buttonClass, Card } from '@erase/ui';
import Link from 'next/link';
import { copy } from '@/copy/en';
import { ERROR_MESSAGES } from '@/copy/errors';

type Tone = 'good' | 'info' | 'warn';

/** The words for one outcome of "create drafts". Every outcome is data, not an error: each says what happened and what is next. */
export function describeOutcome(o: DraftOutcome, name: string): { tone: Tone; text: string } {
  switch (o.outcome) {
    case 'created':
      return { tone: 'good', text: copy.overview.draft.created };
    case 'existing':
      return { tone: 'info', text: copy.overview.draft.existing };
    case 'use_form':
      return { tone: 'info', text: copy.overview.draft.useForm(name) };
    case 'kept':
      return { tone: 'info', text: ERROR_MESSAGES.kept };
    case 'blocked': {
      const known = o.reason && o.reason !== 'not_found' ? (ERROR_MESSAGES as Record<string, string>)[o.reason] : undefined;
      return { tone: 'warn', text: known ?? ERROR_MESSAGES.not_found };
    }
  }
}

/** What happened for each company the person asked about. Text comes from the app, not from the server. */
export function DraftOutcomes({ outcomes, companies, onDismiss }: { outcomes: DraftOutcome[]; companies: CompanyItem[]; onDismiss: () => void }) {
  const nameOf = (id: string): string => companies.find((c) => c.id === id)?.company ?? 'This company';
  const anyDraft = outcomes.some((o) => o.outcome === 'created' || o.outcome === 'existing' || o.outcome === 'use_form');
  return (
    <Card title={copy.overview.draft.resultsTitle}>
      <ul className="list" aria-label={copy.overview.draft.resultsTitle}>
        {outcomes.map((o) => {
          const name = nameOf(o.userCompanyId);
          const { tone, text } = describeOutcome(o, name);
          return (
            <li key={o.userCompanyId}>
              <div style={{ fontWeight: 600, marginBottom: 'var(--space-1)' }}>{name}</div>
              <Alert tone={tone}>{text}</Alert>
              <div className="row" style={{ marginTop: 'var(--space-2)' }}>
                {o.requestId ? (
                  <Link className="ui-link" href={`/requests/${o.requestId}`}>
                    {copy.overview.draft.open}
                  </Link>
                ) : null}
                {o.selfServeUrl ? (
                  <a className="ui-link" href={o.selfServeUrl} target="_blank" rel="noopener noreferrer">
                    {copy.overview.draft.selfServe}
                  </a>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="row" style={{ marginTop: 'var(--space-3)' }}>
        {anyDraft ? (
          <Link href="/requests/review" className={buttonClass('primary')}>
            {copy.overview.draft.review}
          </Link>
        ) : null}
        <Button variant="secondary" onClick={onDismiss}>
          {copy.overview.draft.dismiss}
        </Button>
      </div>
    </Card>
  );
}
