'use client';

import type { CompanyItem } from '@erase/contracts';
import { Checkbox, Chip, Switch } from '@erase/ui';
import Link from 'next/link';
import { copy } from '@/copy/en';
import { formatMonth } from '@/lib/format';

/**
 * One detected company. Everything shown is a hint from message headers: how strong the signs are (Likely or Possible),
 * which signals they rest on, and whether it looks in use. A must-keep company gets an explanation and no deletion
 * promise. The self-serve link is shown before any request. "Keep this" saves at once and is undone if it fails.
 */
export function CompanyRow({
  company,
  selected,
  onSelect,
  onKeep,
  keepBusy,
}: {
  company: CompanyItem;
  selected: boolean;
  onSelect: (id: string, next: boolean) => void;
  onKeep: (id: string, next: boolean) => void;
  keepBusy: boolean;
}) {
  const c = copy.overview.company;
  const blocked = company.mustKeep || company.kept || company.openRequest !== null;
  const name = company.company;

  return (
    <li>
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div className="grow stack" style={{ gap: 'var(--space-2)' }}>
          <Checkbox
            label={<span style={{ fontWeight: 600 }}>{name}</span>}
            aria-label={c.select(name)}
            checked={selected && !blocked}
            disabled={blocked}
            onChange={(e) => onSelect(company.id, e.target.checked)}
          />
          <div className="muted" style={{ marginLeft: 'calc(22px + var(--space-3))' }}>
            {company.domain} · {copy.labels.category[company.category]} · {c.firstLast(formatMonth(company.firstSeen), formatMonth(company.lastSeen))}
          </div>
          <div className="chips" style={{ marginLeft: 'calc(22px + var(--space-3))' }}>
            <Chip tone={company.confidence === 'high' ? 'info' : 'neutral'}>{copy.labels.confidence[company.confidence]}</Chip>
            {company.activity ? <Chip tone={company.activity === 'looks_in_use' ? 'good' : 'warn'}>{copy.labels.activity[company.activity]}</Chip> : null}
            {company.mustKeep ? <Chip tone="neutral">{c.mustKeepChip}</Chip> : null}
            {company.kept ? <Chip tone="neutral">{c.keptChip}</Chip> : null}
            {company.openRequest ? <Chip tone="info">{c.openRequest(copy.labels.requestStatus[company.openRequest.status as keyof typeof copy.labels.requestStatus] ?? company.openRequest.status)}</Chip> : null}
          </div>
          <div className="muted" style={{ marginLeft: 'calc(22px + var(--space-3))' }}>
            {copy.labels.confidenceHelp[company.confidence]}
            {company.signals.length ? ` ${company.signals.map((s) => copy.labels.signals[s]).join(', ')}.` : ''}
          </div>
          {company.mustKeep ? (
            <div style={{ marginLeft: 'calc(22px + var(--space-3))' }}>{c.mustKeep}</div>
          ) : company.kept ? (
            <div style={{ marginLeft: 'calc(22px + var(--space-3))' }}>{c.kept}</div>
          ) : null}
          {company.selfServeUrl ? (
            <div style={{ marginLeft: 'calc(22px + var(--space-3))' }}>
              <a className="ui-link" href={company.selfServeUrl} target="_blank" rel="noopener noreferrer">
                {c.selfServe(name)}
              </a>
              <div className="muted">{c.selfServeNote}</div>
            </div>
          ) : null}
          {company.openRequest ? (
            <div style={{ marginLeft: 'calc(22px + var(--space-3))' }}>
              <Link className="ui-link" href={`/requests/${company.openRequest.id}`}>
                {c.openRequestLink}
              </Link>
            </div>
          ) : null}
        </div>
        {company.mustKeep ? null : (
          <div style={{ minWidth: 220 }}>
            <Switch label={c.keepLabel} description={c.keepNote} checked={company.kept} busy={keepBusy} onChange={(next) => onKeep(company.id, next)} />
          </div>
        )}
      </div>
    </li>
  );
}
