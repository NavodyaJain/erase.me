# Web origin setup (web app and API on different ports or hosts)

The web app (`apps/web`) and the API (`services/api`) are separate servers. Locally they are `http://localhost:3000` and `http://localhost:4000`. In production they will be on sibling hosts (for example `app.erase.me` and `api.erase.me`). Everything that depends on where the web app runs comes from configuration. Nothing is hard-coded.

## Settings

| Where | Setting | What it drives |
| --- | --- | --- |
| API `.env` | `WEB_ORIGIN` | The one origin allowed by **CORS**, the one origin the **CSRF origin check** accepts, and where the browser is sent **after Google**. Scheme, host and optional port only (a trailing slash is normalised; a path is refused). Must be `https` in staging and production. |
| API `.env` | `API_PUBLIC_URL` | The Google redirect URI base (`<API_PUBLIC_URL>/v1/auth/google/callback`), and whether cookies get `Secure` (when it is `https`). |
| API `.env` | `COOKIE_DOMAIN` | Leave empty on localhost. Set to the parent domain (for example `.erase.me`) when web and API are sibling hosts, so the session cookie is sent to both. |
| Web `apps/web/.env.local` | `NEXT_PUBLIC_API_URL` | Where the browser sends API calls (default `http://localhost:4000` in development only). Also the only extra origin the web app's content-security-policy allows for `connect-src`. |
| Google Cloud | Authorised JavaScript origin | The web origin (`WEB_ORIGIN`). |
| Google Cloud | Authorised redirect URI | The **API** callback: `<API_PUBLIC_URL>/v1/auth/google/callback`. Not a web URL. |

## How each piece works

- **Cookies.** The session cookie is `HttpOnly`, `SameSite=Lax`, host-only by default. A cookie is scoped to the host, not the port, so `localhost:3000` and `localhost:4000` share it, and it counts as same-site. The web app never reads it: it sends it with `credentials: 'include'` (`@erase/api-client` does this on every call). In production set `COOKIE_DOMAIN` to the parent domain and use `https` for both.
- **CORS.** The API answers only `Origin == WEB_ORIGIN`, with `Access-Control-Allow-Credentials: true`. Preflight allows `GET, POST, PUT, PATCH, DELETE` and the headers `content-type`, `x-csrf-token` and `idempotency-key`. Another origin gets no CORS headers, so the browser blocks it.
- **CSRF origin check.** Every POST, PUT, PATCH and DELETE needs the `x-csrf-token` header (from `GET /v1/me`) **and**, when the browser sends an `Origin`, that origin must equal `WEB_ORIGIN`. A request from any other origin is refused with 403 `forbidden`.
- **After sign-in.** Google returns to the API callback, which sets the session cookie and redirects the browser to `WEB_ORIGIN/` (or `WEB_ORIGIN/?auth_error=<reason>` on failure, `WEB_ORIGIN/?inbox=connected` after connecting an inbox). The web app's `/` route handles those.
- **Service worker.** It only ever sees the web origin, and it never handles API calls (see `apps/web/README.md`).

## Changing the web port

1. Set `WEB_ORIGIN=http://localhost:<port>` in the API `.env` and restart the API.
2. Run the web app on that port (`next dev --port <port>`).
3. Add the new origin as an authorised JavaScript origin in Google Cloud.
4. Nothing else changes. `services/api/src/config/web-origin.integration.test.ts` checks all of this with a web origin that is not the default.

## Common mistakes

- `WEB_ORIGIN` with a path, or a different port from the one the web app really uses: CORS and the CSRF check fail with 403 or a blocked request in the browser console.
- Opening the web app as `127.0.0.1` while `WEB_ORIGIN` says `localhost`: different origins, and different cookie hosts.
- Registering the **web** URL as the Google redirect URI: it must be the API callback.
