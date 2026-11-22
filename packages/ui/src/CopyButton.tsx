import { useEffect, useRef, useState } from 'react';
import { Button } from './Button.js';

/**
 * Copies text to the clipboard and says so. The text is passed in and never stored. Falls back to selecting a
 * hidden textarea where the async clipboard API is missing.
 */
export function CopyButton({ text, label = 'Copy', copiedLabel = 'Copied' }: { text: string; label?: string; copiedLabel?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    let ok: boolean;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      area.remove();
    }
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2500);
  }

  return (
    <>
      <Button variant="secondary" onClick={() => void copy()}>
        {state === 'copied' ? copiedLabel : label}
      </Button>
      <span role="status" className="ui-visually-hidden">
        {state === 'copied' ? copiedLabel : state === 'failed' ? 'Could not copy. Select the text and copy it by hand.' : ''}
      </span>
    </>
  );
}
