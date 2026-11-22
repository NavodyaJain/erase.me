import { useId } from 'react';

/** A labelled on/off switch. Space and Enter toggle it; `busy` disables it while a change is being saved. */
export function Switch({
  label,
  description,
  checked,
  onChange,
  busy = false,
  disabled = false,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="ui-switch-row">
      <div>
        <div id={`${id}-label`} style={{ fontWeight: 600, fontSize: 'var(--fs-14)' }}>
          {label}
        </div>
        {description ? (
          <div id={`${id}-desc`} className="ui-field-hint">
            {description}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        className="ui-switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-desc` : undefined}
        aria-busy={busy || undefined}
        disabled={disabled || busy}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}
