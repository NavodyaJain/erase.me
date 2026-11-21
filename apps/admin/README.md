# admin.erase.me
Internal operations: overview, requests, support tickets, companies, users, audit log.
Separate sessions from the user app. SSO + 2FA + IP allowlist.
Ticket handling lives here: agents see masked user data; revealing needs a reason and is logged.
Roles and permissions are enforced by `services/api`, never only in the UI.
