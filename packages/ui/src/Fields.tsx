import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';

interface FieldShell {
  label: string;
  hint?: string;
  error?: string;
}

function Shell({ id, label, hint, error, children }: FieldShell & { id: string; children: ReactNode }) {
  return (
    <div className="ui-field">
      <label className="ui-field-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? (
        <div id={`${id}-hint`} className="ui-field-hint">
          {hint}
        </div>
      ) : null}
      {error ? (
        <div id={`${id}-error`} className="ui-field-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

const describedBy = (id: string, hint?: string, error?: string): string | undefined =>
  [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;

export function TextField({ label, hint, error, ...rest }: FieldShell & Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'id'>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error}>
      <input {...rest} id={id} className="ui-field-control" aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} />
    </Shell>
  );
}

export function TextArea({ label, hint, error, ...rest }: FieldShell & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className' | 'id'>) {
  const id = useId();
  return (
    <Shell id={id} label={label} hint={hint} error={error}>
      <textarea {...rest} id={id} className="ui-field-control" aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} />
    </Shell>
  );
}

/** A checkbox with a visible label and a 44px touch target. */
export function Checkbox({ label, ...rest }: { label: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'>) {
  return (
    <label className="ui-check">
      <input {...rest} type="checkbox" className="ui-check-input" />
      <span className="ui-check-box" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}
