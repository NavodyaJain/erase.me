import { Card } from '@erase/ui';
import { copy } from '@/copy/en';

/**
 * What is read, kept and never done, shown before Google's consent screen (F1-AC2). It states both permissions
 * plainly: headers are read, and send is asked for now but used only after the person approves a request.
 */
export function ConsentPanel({ headingLevel = 2 }: { headingLevel?: 2 | 3 }) {
  const c = copy.consent;
  return (
    <Card title={c.title} headingLevel={headingLevel} aria-label={c.title}>
      <dl className="stack" style={{ margin: 0 }}>
        {[c.read, c.keep, c.later, c.never].map((item) => (
          <div key={item.heading}>
            <dt style={{ fontWeight: 600 }}>{item.heading}</dt>
            <dd style={{ margin: 0, color: 'var(--color-muted)', fontSize: 'var(--fs-14)' }}>{item.body}</dd>
          </div>
        ))}
      </dl>
      <p className="muted" style={{ marginTop: 'var(--space-3)' }}>
        {c.disconnect}
      </p>
    </Card>
  );
}
