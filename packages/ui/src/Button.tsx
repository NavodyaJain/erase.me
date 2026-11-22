import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet';

/** The class names of a button, for a link that should look like one. */
export const buttonClass = (variant: ButtonVariant = 'secondary', block = false): string => cx('ui-btn', `ui-btn-${variant}`, block && 'ui-btn-block');

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  block?: boolean;
  /** Ignores clicks and shows a busy state while true. */
  loading?: boolean;
  children: ReactNode;
}

/** A button. `type` defaults to "button" so it never submits a form by accident. */
export function Button({ variant = 'secondary', block = false, loading = false, disabled, type = 'button', children, ...rest }: ButtonProps) {
  return (
    <button {...rest} type={type} className={buttonClass(variant, block)} disabled={disabled || loading} aria-busy={loading || undefined}>
      {children}
    </button>
  );
}
