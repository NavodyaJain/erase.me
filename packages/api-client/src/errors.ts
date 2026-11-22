import type { ProblemCode, ProblemDraftUnsafe, ProblemUseForm } from '@erase/contracts';

/**
 * A failed API call. The API answers with RFC 9457 problem details and a stable `code`: branch on `code`, never on
 * `title` or `detail` (those are sentences for a person, and they never contain draft text, addresses or tokens).
 *
 * Two codes are not from the API: `network_error` (the call did not get an answer, status 0) and `unreadable_response`
 * (an error status whose body was not problem details).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ProblemCode | 'network_error' | 'unreadable_response',
    readonly title: string,
    readonly detail: string | undefined,
    readonly requestId: string | undefined,
    /** Fields beyond the standard ones: `formUrl` for `use_form`, `findings` for `draft_unsafe`, `errors` for `validation_failed`. */
    readonly extensions: Readonly<Record<string, unknown>>,
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
  }

  /** Builds the error from a failed response and its parsed body (undefined when the body was not JSON). */
  static fromResponse(response: Response, body: unknown): ApiError {
    if (body && typeof body === 'object' && 'code' in body && 'title' in body) {
      const { type: _type, title, status: _status, code, detail, instance: _instance, requestId, ...extensions } = body as Record<string, unknown>;
      return new ApiError(
        response.status,
        code as ProblemCode,
        String(title),
        typeof detail === 'string' ? detail : undefined,
        typeof requestId === 'string' ? requestId : response.headers.get('x-request-id') ?? undefined,
        extensions,
      );
    }
    return new ApiError(response.status, 'unreadable_response', response.statusText || 'Request failed', undefined, response.headers.get('x-request-id') ?? undefined, {});
  }

  static network(): ApiError {
    return new ApiError(0, 'network_error', 'The server could not be reached', 'Check the connection and try again.', undefined, {});
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

/** The company takes requests through a web form: show the draft to copy, and link to `formUrl`. */
export function isUseForm(e: unknown): e is ApiError & { code: 'use_form'; extensions: Pick<ProblemUseForm, 'formUrl' | 'selfServeUrl'> } {
  return isApiError(e) && e.code === 'use_form' && typeof e.extensions.formUrl === 'string';
}

/** The draft changed since the person saw it: reload the request and show the latest version. */
export const isStaleDraft = (e: unknown): boolean => isApiError(e) && e.status === 409 && e.code === 'draft_changed';

/** The text looks like it holds an ID number or an unresolved placeholder. `findings` names the kinds, never the text. */
export function isDraftUnsafe(e: unknown): e is ApiError & { code: 'draft_unsafe'; extensions: Pick<ProblemDraftUnsafe, 'findings'> } {
  return isApiError(e) && e.code === 'draft_unsafe' && Array.isArray(e.extensions.findings);
}

/** No deletion request is offered for this company, because it is needed to keep an account working, or the user chose to keep it. */
export const isNotOffered = (e: unknown): boolean => isApiError(e) && (e.code === 'must_keep' || e.code === 'kept');

/** Sending is switched off in this environment (not yet enabled, or the statute wording is not verified). */
export const isSendUnavailable = (e: unknown): boolean => isApiError(e) && e.status === 503 && (e.code === 'real_send_blocked' || e.code === 'send_disabled');
