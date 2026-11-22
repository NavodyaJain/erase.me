import type { ReactNode } from 'react';
import { cx } from './cx';

export type AlertTone = 'info' | 'good' | 'warn' | 'bad';

/** A message. Problems use role "alert" so screen readers announce them; the rest use "status". */
export function Alert({ tone = 'info', title, children }: { tone?: AlertTone; title?: string; children?: ReactNode }) {
  return (
    <div className={cx('ui-alert', `ui-alert-${tone}`)} role={tone === 'bad' || tone === 'warn' ? 'alert' : 'status'}>
      {title ? <div className="ui-alert-title">{title}</div> : null}
      {children ? <div>{children}</div> : null}
    </div>
  );
}
