export { createApiClient, createIdempotencyKey, IDEMPOTENCY_KEY_PATTERN, type ApiClient, type ApiClientOptions, type EditDraftInput } from './client.js';
export { ApiError, isApiError, isDraftUnsafe, isNotOffered, isSendUnavailable, isStaleDraft, isUseForm } from './errors.js';
export type { CompanyItem, DraftOutcome, Inbox, Me, ProblemCode, RequestListItem, RequestView, Scan, SendResponse } from '@erase/contracts';
