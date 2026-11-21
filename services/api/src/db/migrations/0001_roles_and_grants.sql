-- Roles and privileges (TRD 6.4: request_events and audit_log are append-only for the app role).
--
-- Migrations run as the owner role (`erase` locally). The API connects as a login role that is a
-- member of `erase_app`, which is created here with no login and no password. Phase 1 grants no DELETE
-- anywhere: purging and account deletion run as the owner in Phase 2, with their own reviewed path.
--
-- Any new table is invisible to the app role until a migration grants it. The integration test
-- "every table is classified" fails until that is done.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erase_app') THEN
    CREATE ROLE erase_app NOLOGIN;
  END IF;
END
$$;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO erase_app;--> statement-breakpoint

-- Mutable tables: no DELETE or TRUNCATE.
GRANT SELECT, INSERT, UPDATE ON "users", "inboxes", "scans", "companies", "user_companies", "requests", "reply_labels" TO erase_app;--> statement-breakpoint

-- Append-only: INSERT and SELECT. request_drafts is immutable too, so an approved draft cannot be rewritten:
-- an edit inserts a new version with a new hash.
GRANT SELECT, INSERT ON "request_drafts", "request_events", "audit_log" TO erase_app;--> statement-breakpoint

-- Local development: docker/postgres/init creates the login role `erase_api`. Elsewhere the host does.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erase_api') THEN
    GRANT erase_app TO erase_api;
  END IF;
END
$$;
