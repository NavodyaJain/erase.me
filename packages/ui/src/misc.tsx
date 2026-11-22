import type { CSSProperties, ReactNode } from 'react';

/** Text for screen readers only. */
export const VisuallyHidden = ({ children }: { children: ReactNode }) => <span className="ui-visually-hidden">{children}</span>;

/** A grey placeholder while something loads. Hidden from assistive tech: pair it with a status message. */
export const Skeleton = ({ width = '100%', height = 16 }: { width?: CSSProperties['width']; height?: CSSProperties['height'] }) => (
  <span className="ui-skeleton" aria-hidden="true" style={{ width, height }} />
);
