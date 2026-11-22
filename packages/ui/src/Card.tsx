import type { ReactNode } from 'react';
import { cx } from './cx.js';

export function Card({
  title,
  headingLevel = 2,
  padded = true,
  children,
  ...rest
}: {
  title?: ReactNode;
  headingLevel?: 2 | 3;
  padded?: boolean;
  children: ReactNode;
  'aria-label'?: string;
}) {
  const Heading = `h${headingLevel}` as const;
  return (
    <section className={cx('ui-card', padded && 'ui-card-pad')} {...rest}>
      {title ? <Heading className="ui-card-title">{title}</Heading> : null}
      {children}
    </section>
  );
}
