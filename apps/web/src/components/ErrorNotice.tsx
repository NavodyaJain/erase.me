'use client';

import { Alert, Button } from '@erase/ui';
import { copy } from '@/copy/en';
import { describeError } from '@/copy/errors';

/**
 * Shows any failure with the right message for its code. Retry is offered only when asked for. For
 * `send_outcome_unknown` the message is a warning: the person has something to check before doing anything else.
 */
export function ErrorNotice({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  const { code, message } = describeError(error);
  const careful = code === 'send_outcome_unknown' || code === 'send_in_progress';
  return (
    <div data-error-code={code}>
      <Alert tone={careful ? 'warn' : 'bad'} {...(title ? { title } : {})}>
        {message}
      </Alert>
      {onRetry ? (
        <div style={{ marginTop: 'var(--space-2)' }}>
          <Button variant="secondary" onClick={onRetry}>
            {copy.common.retry}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
