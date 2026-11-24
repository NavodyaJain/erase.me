import type { AccountDeletion, CompanyItem, DraftOutcome, FollowupSendResponse, Inbox, Me, paths, RequestListItem, RequestView, Scan, SendResponse } from '@erase/contracts';
import createClient from 'openapi-fetch';
import { ApiError, isApiError } from './errors';

/** What the person reports the company answered. `no_answer_yet` takes a report back. */
export type Outcome = NonNullable<RequestView['outcome']>['value'];

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
    account: {
      /**
       * Where "Delete my data" stands, for the Your data screen. While it is pending (`status: "deleting"`) reply checks, follow-ups
       * and sending are paused, `deleteAfter` says when the data is deleted, and `googleAccess.message` (when set) tells the person
       * to remove Erase.me in their Google account settings. `gmailCopies` says their own Gmail copies are not touched.
       */
      deletion: (): Promise<AccountDeletion> => call(() => http.GET('/v1/me/deletion')),
      /** Starts the undo period (7 days by default). The session stays, limited: every other call answers 403 `deletion_pending`. */
      requestDeletion: (): Promise<AccountDeletion> => mutate(() => http.DELETE('/v1/me')),
      /** Cancels it inside the undo period. 409 `undo_window_closed` after it, `not_pending_deletion` when none is pending. */
      undoDeletion: (): Promise<AccountDeletion> => mutate(() => http.POST('/v1/me/deletion/undo')),
      /** Skips the undo period and deletes now. Every session ends, so the client forgets its CSRF token. */
      deleteNow: async (): Promise<AccountDeletion> => {
        const result = await mutate(() => http.POST('/v1/me/deletion/now'));
        csrfToken = undefined;
        return result;
      },
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
       * The person reports what the company answered. Show it as "Reported by you", never as a verified fact: nothing
       * infers it, not even a reply that was found. It can be set whether or not a reply was detected, and `no_answer_yet`
       * takes it back.
       */
      setOutcome: (id: string, outcome: Outcome): Promise<RequestView> =>
        mutate(() => http.PUT('/v1/requests/{id}/outcome', { params: { path: { id } }, body: { outcome } })),
      /**
       * For a web-form company: the person pasted the draft into the form. Nothing is sent. `draftHash` is the version
       * they copied (409 `draft_changed` if it is no longer the latest).
       */
      /**
       * Prepares the follow-up to a request that has had no reply (offered `followup.dueAt`, 30 days after sending by default).
       * Asking again returns the draft that exists. Nothing is sent. 409 `followup_not_due` before the day, `followup_limit_reached`
       * after the allowed follow-ups.
       */
      createFollowup: (id: string): Promise<RequestView> => mutate(() => http.POST('/v1/requests/{id}/followup', { params: { path: { id } } })),
      /** A new version of the follow-up draft. `baseHash` is the version being edited (409 `draft_changed` if it is no longer the latest, never retried by itself). */
      editFollowupDraft: (id: string, input: EditDraftInput): Promise<RequestView> =>
        mutate(() => http.PATCH('/v1/requests/{id}/followup/draft', { params: { path: { id } }, body: input })),
      /** Approves exactly the follow-up version the person was shown (`draftHash`). A web-form follow-up is not approved here (409 `use_form`). */
      approveFollowup: (id: string, draftHash: string): Promise<RequestView> =>
        mutate(() => http.POST('/v1/requests/{id}/followup/approve', { params: { path: { id } }, body: { draftHash } })),
      /**
       * Sends an approved follow-up in the first message's Gmail conversation. Needs an Idempotency-Key, like `send`: make one with
       * `createIdempotencyKey()` when the person confirms and reuse it for every retry. In development and test it answers
       * `delivery: "fake"`: nothing left the machine.
       */
      sendFollowup: (id: string, idempotencyKey: string): Promise<FollowupSendResponse> => {
        if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
          throw new TypeError('The idempotency key must be 8 to 128 characters: letters, digits and . _ : -');
        }
        return mutate(() => http.POST('/v1/requests/{id}/followup/send', { params: { path: { id }, header: { 'Idempotency-Key': idempotencyKey } } }));
      },
      /** For a web-form request: the person pasted the follow-up into the form. Nothing is sent. `draftHash` is the version they copied. */
      markFollowupSubmitted: (id: string, draftHash: string): Promise<RequestView> =>
        mutate(() => http.POST('/v1/requests/{id}/followup/submitted', { params: { path: { id } }, body: { draftHash } })),
      markSubmitted: (id: string, draftHash: string): Promise<RequestView> =>
        mutate(() => http.POST('/v1/requests/{id}/submitted', { params: { path: { id } }, body: { draftHash } })),
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
