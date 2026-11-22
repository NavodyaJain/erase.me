# @erase/api-client
Typed client for the core API, generated from its OpenAPI contract (`@erase/contracts`). The only way the apps call the API.

```ts
import { createApiClient, createIdempotencyKey, isUseForm } from '@erase/api-client';

const api = createApiClient({ baseUrl: 'http://localhost:4000' });
location.href = api.signInUrl();        // Google sign-in is a browser navigation

const me = await api.me();               // also keeps the CSRF token
const companies = await api.companies.list();
const outcomes = await api.requests.createDrafts([companies[0].id]);

const key = createIdempotencyKey();      // once per "send" action; reuse it for every retry
try {
  await api.requests.send(requestId, key);
} catch (e) {
  if (isUseForm(e)) showForm(e.extensions.formUrl);   // a web-form company: copy the draft, open the form
}
```

What it handles for you:
- **Cookies.** Every call sends the session cookie (`credentials: 'include'`).
- **CSRF.** Every POST, PUT, PATCH and DELETE carries `x-csrf-token`. The token comes from `GET /v1/me`, is fetched on first need, and is refreshed once if the API refuses it.
- **Idempotency.** `requests.send` needs an `Idempotency-Key` and refuses to run without a valid one.
- **Errors.** Failures are `ApiError`s with the API's stable `code` (`draft_changed`, `use_form`, `must_keep`, `kept`, `no_contact`, `real_send_blocked`, `send_disabled`, ...). Branch on `code`. Helpers: `isUseForm`, `isStaleDraft`, `isDraftUnsafe`, `isNotOffered`, `isSendUnavailable`.
- **Outcomes are data.** `requests.createDrafts` returns one outcome per company (`created`, `existing`, `use_form`, `kept`, `blocked` with a `reason`); a blocked company is not an error.

Source only, no build step. Tests use a fake server, so they need no network and no API.
