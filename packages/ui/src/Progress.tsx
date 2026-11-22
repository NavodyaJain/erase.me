/** Progress with a text value, for scans. The label is the accessible name. */
export function ProgressBar({ label, value, detail }: { label: string; value: number; detail?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="ui-progress">
      <div className="ui-progress-label">
        <span>{detail ?? label}</span>
        <span>{pct}%</span>
      </div>
      <div className="ui-progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="ui-progress-bar" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
