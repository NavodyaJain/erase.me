import type { CompanyItem, DraftOutcome, Inbox, Me, paths, RequestListItem, RequestView, Scan, SendResponse } from '@erase/contracts';
import createClient from 'openapi-fetch';
import { ApiError, isApiError } from './errors.js';

export interface ApiClientOptions {
  /** The API origin, for example `http://localhost:4000`. */
  baseUrl: string;
  /** Replaces `fetch`, for tests or a platform with its own. It receives a ready `Request`. */
  fetch?: (request: Request) => Promise<Response>;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** What the API accepts as an Idempotency-Key. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * A fresh key for one "send" action. Make it once when the person confirms, keep it, and reuse the same key for
 * every retry of that action: the API then returns the first answer and never sends twice.
 */
export const createIdempotencyKey = (): string => `send-${globalThis.crypto.randomUUID()}`;

interface Result<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

export interface EditDraftInput {
  /** The hash of the version being edited. If it is no longer the latest, the API answers 409 `draft_changed`. */
  baseHash: string;
  subject: string;
  body: string;
}

/**
 * The typed client for the core API. It:
 * - sends the session cookie on every call (`credentials: 'include'`),
 * - sends the CSRF token on every POST, PUT, PATCH and DELETE (taken from `GET /v1/me`, fetched on first need, and
 *   refreshed once if the API says it is no longer valid),
 * - requires an Idempotency-Key for send,
 * - turns every failure into an `ApiError` with the API's stable `code`.
 */
export function createApiClient(opts: ApiClientOptions) {
  let csrfToken: string | undefined;

  const http = createClient<paths>({
    baseUrl: opts.baseUrl,
    credentials: 'include',
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  http.use({
    onRequest({ request }) {
      if (!SAFE_METHODS.has(request.method) && csrfToken) request.headers.set('x-csrf-token', csrfToken);
      return request;
    },
  });

  async function callFull<T>(run: () => Promise<Result<T>>): Promise<{ data: T; response: Response }> {
    let result: Result<T>;
    try {
      result = await run();
    } catch {
      throw ApiError.network();
    }
    if (!result.response.ok) throw ApiError.fromResponse(result.response, result.error);
    return { data: result.data as T, response: result.response };
  }
  const call = async <T>(run: () => Promise<Result<T>>): Promise<T> => (await callFull(run)).data;

  async function me(): Promise<Me> {
    const user = await call(() => http.GET('/v1/me'));
    csrfToken = user.csrfToken;
    return user;
  }

  /** A state-changing call: needs the CSRF token, and gets one refresh if the API refuses it. */
  async function mutateFull<T>(run: () => Promise<Result<T>>): Promise<{ data: T; response: Response }> {
    if (!csrfToken) await me();
    try {
      return await callFull(run);
    } catch (e) {
      if (isApiError(e) && e.status === 403 && e.code === 'forbidden') {
        await me();
        return callFull(run);
      }
      throw e;
    }
  }
  const mutate = async <T>(run: () => Promise<Result<T>>): Promise<T> => (await mutateFull(run)).data;

  return {
    /** The underlying client, for anything not wrapped below. It still sends credentials and the CSRF token. */
    raw: http,

    /** Where to send the browser to sign in. Not a fetch call: Google's consent screen needs a navigation. */
    signInUrl: (): string => new URL('/v1/auth/google/start', opts.baseUrl).toString(),

    csrf: {
      get: (): string | undefined => csrfToken,
      set: (token: string | undefined): void => {
        csrfToken = token;
      },
    },

    /** The signed-in user. Also stores the CSRF token. Rejects with a 401 `ApiError` when signed out. */
    me,
    logout: async (): Promise<void> => {
      await mutate(() => http.POST('/v1/auth/logout'));
      csrfToken = undefined;
    },
    /** Starts account deletion. Every session ends at once. */
    deleteAccount: async (): Promise<void> => {
      await mutate(() => http.DELETE('/v1/me'));
      csrfToken = undefined;
    },

    inboxes: {
      list: async (): Promise<Inbox[]> => (await call(() => http.GET('/v1/inboxes'))).inboxes,
      /** The Google consent URL. Show the "what we read, keep and never do" panel first, then navigate to it. */
      startConnect: async (): Promise<string> => (await mutate(() => http.POST('/v1/inboxes/connect/start'))).authorizationUrl,
      disconnect: (id: string) => mutate(() => http.DELETE('/v1/inboxes/{id}', { params: { path: { id } } })),
      /** `alreadyRunning` is true when a scan was already active and is returned instead of a new one. */
      startScan: async (id: string): Promise<{ scan: Scan; alreadyRunning: boolean }> => {
        const { data, response } = await mutateFull(() => http.POST('/v1/inboxes/{id}/scan', { params: { path: { id } } }));
        return { scan: data.scan, alreadyRunning: response.status === 200 };
      },
      latestScan: async (id: string): Promise<Scan> => (await call(() => http.GET('/v1/inboxes/{id}/scan', { params: { path: { id } } }))).scan,
    },

    companies: {
      list: async (): Promise<CompanyItem[]> => (await call(() => http.GET('/v1/companies'))).companies,
      /** "Keep this": no request is offered for it until cleared. */
      keep: async (id: string): Promise<CompanyItem> => (await mutate(() => http.PUT('/v1/companies/{id}/keep', { params: { path: { id } } }))).company,
      unkeep: async (id: string): Promise<CompanyItem> => (await mutate(() => http.DELETE('/v1/companies/{id}/keep', { params: { path: { id } } }))).company,
    },

    requests: {
      /** One outcome per company: `created`, `existing`, `use_form`, `kept` or `blocked`. Not an error when some are blocked. */
      createDrafts: async (userCompanyIds: string[]): Promise<DraftOutcome[]> =>
        (await mutate(() => http.POST('/v1/requests/drafts', { body: { userCompanyIds } }))).results,
      list: async (): Promise<RequestListItem[]> => (await call(() => http.GET('/v1/requests'))).requests,
      get: (id: string): Promise<RequestView> => call(() => http.GET('/v1/requests/{id}', { params: { path: { id } } })),
      editDraft: (id: string, input: EditDraftInput): Promise<RequestView> =>
        mutate(() => http.PATCH('/v1/requests/{id}/draft', { params: { path: { id } }, body: input })),
      /** Approves exactly the version the person was shown (`draftHash`). */
      approve: (id: string, draftHash: string): Promise<RequestView> =>
        mutate(() => http.POST('/v1/requests/{id}/approve', { params: { path: { id } }, body: { draftHash } })),
      close: (id: string): Promise<RequestView> => mutate(() => http.POST('/v1/requests/{id}/close', { params: { path: { id } } })),
      /**
       * Sends an approved request. `idempotencyKey` is required: make one with `createIdempotencyKey()` when the person
       * confirms and reuse it for every retry, so a retry can never send twice.
       */
      send: (id: string, idempotencyKey: string): Promise<SendResponse> => {
        if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
          throw new TypeError('The idempotency key must be 8 to 128 characters: letters, digits and . _ : -');
        }
        return mutate(() => http.POST('/v1/requests/{id}/send', { params: { path: { id }, header: { 'Idempotency-Key': idempotencyKey } } }));
      },
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
