export { createApiClient, createIdempotencyKey, IDEMPOTENCY_KEY_PATTERN, type ApiClient, type ApiClientOptions, type EditDraftInput, type Outcome } from './client';
export { ApiError, isApiError, isDraftUnsafe, isFollowupLimitReached, isFollowupNotDue, isNotFormRequest, isNotOffered, isSendUnavailable, isStaleDraft, isUseForm } from './errors';
export type { CompanyItem, DraftOutcome, FollowupSendResponse, Inbox, Me, ProblemCode, RequestListItem, RequestView, Scan, SendResponse } from '@erase/contracts';
