'use client';

import { Alert, Button } from '@erase/ui';
import { useEffect, useState } from 'react';
import { copy } from '@/copy/en';
import { applyUpdate, isStandalone, markShown, readLastShown, shouldShowInstallHint, watchForUpdate } from '@/lib/pwa';

/**
 * Registers the service worker (production only: in development it would cache stale code), offers an update only
 * when the person asks for it, and shows the iPhone "Add to Home Screen" hint at most once every 30 days.
 */
export function PwaChrome() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [hint, setHint] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    let cancelled = false;
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((registration) => {
        if (!cancelled) watchForUpdate(registration, setWaiting);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const show = shouldShowInstallHint({
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints,
      standalone: isStandalone(),
      lastShownAt: readLastShown(window.localStorage),
      now: Date.now(),
    });
    if (show) {
      markShown(window.localStorage, Date.now());
      setHint(true);
    }
  }, []);

  if (!waiting && !hint) return null;
  return (
    <div className="pwa-chrome" style={{ position: 'fixed', left: 'var(--space-3)', right: 'var(--space-3)', bottom: 'calc(72px + env(safe-area-inset-bottom))', zIndex: 30, display: 'grid', gap: 'var(--space-2)' }}>
      {waiting ? (
        <Alert tone="info" title={copy.pwa.updateTitle}>
          <div className="row">
            <span className="grow">{copy.pwa.updateBody}</span>
            <Button variant="primary" onClick={() => applyUpdate(waiting, () => window.location.reload())}>
              {copy.pwa.updateAction}
            </Button>
          </div>
        </Alert>
      ) : null}
      {hint ? (
        <Alert tone="info" title={copy.pwa.installTitle}>
          <div className="row">
            <span className="grow">{copy.pwa.installBody}</span>
            <Button variant="secondary" onClick={() => setHint(false)}>
              {copy.pwa.dismiss}
            </Button>
          </div>
        </Alert>
      ) : null}
    </div>
  );
}
