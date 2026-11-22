import type { ReactNode } from 'react';
import { cx } from './cx';

export type ChipTone = 'bad' | 'good' | 'warn' | 'neutral' | 'info';

/** A status chip. It always carries a text label, so colour alone never carries meaning. */
export function Chip({ tone = 'neutral', children }: { tone?: ChipTone; children: ReactNode }) {
  return <span className={cx('ui-chip', `ui-chip-${tone}`)}>{children}</span>;
}
