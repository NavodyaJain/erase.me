-- Phase 2, Task 6: purge. Hand-written parts follow the generated table and column statements.
-- Pure helpers used by a CHECK and by the purge functions. They read no table.
CREATE FUNCTION public.counts_only(j jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT jsonb_typeof(j) = 'object'
    AND NOT EXISTS (SELECT 1 FROM jsonb_each(j) e WHERE jsonb_typeof(e.value) <> 'number' OR e.value::text !~ '^[0-9]{1,12}$')
$$;--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"task" text NOT NULL,
	"dry_run" boolean NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_runs_id_format" CHECK ("job_runs"."id" ~ '^job_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "job_runs_task" CHECK ("job_runs"."task" IN ('purge_user', 'purge_inboxes', 'purge_users', 'purge_sessions', 'purge_requests')),
	CONSTRAINT "job_runs_counts_only" CHECK (public.counts_only("job_runs"."counts"))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "token_revoke_failed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "job_runs_task_started_idx" ON "job_runs" USING btree ("task","started_at");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_deletion_dates" CHECK ("users"."deletion_due_at" IS NULL OR "users"."deletion_requested_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_token_revoke_failed_range" CHECK ("users"."token_revoke_failed" >= 0);
--> statement-breakpoint
-- An account deleted under the old flow was anonymised at once and its rows were left in place. Treat it as due now, so the
-- purge removes them; the tombstone is written again when that is done.
UPDATE public.users SET deletion_requested_at = coalesce(deleted_at, updated_at), deletion_due_at = coalesce(deleted_at, updated_at), deleted_at = NULL WHERE status = 'deleting' AND deletion_requested_at IS NULL;--> statement-breakpoint
-- The app reads the run log. Only the purge functions below write it.
GRANT SELECT ON "job_runs" TO erase_app;--> statement-breakpoint
CREATE FUNCTION public._new_job_id() RETURNS text
  LANGUAGE sql VOLATILE SET search_path = pg_catalog AS $$
  SELECT 'job_' || string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + floor(random() * 32)::int, 1), '') FROM generate_series(1, 26)
$$;--> statement-breakpoint
CREATE FUNCTION public._add_counts(a jsonb, b jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
  FROM (SELECT k, sum(v)::bigint AS v
        FROM (SELECT key AS k, value::text::bigint AS v FROM jsonb_each(a)
              UNION ALL
              SELECT key, value::text::bigint FROM jsonb_each(b)) x
        GROUP BY k) y
$$;--> statement-breakpoint
-- Removes one batch of one person's data. Refuses unless that person asked for deletion and the undo period is over.
-- The batch limit applies to each table; `done` is 1 once the tombstone has been written, 0 while more is left.
CREATE FUNCTION public._purge_user_rows(p_user_id text, p_limit integer, p_dry_run boolean) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  u record;
  c jsonb := '{}'::jsonb;
  n integer;
  req_ids text[];
BEGIN
  SELECT id, status, deletion_due_at INTO u FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('users_missing', 1, 'done', 1); END IF;
  IF u.status <> 'deleting' OR u.deletion_due_at IS NULL OR u.deletion_due_at > now() THEN
    RAISE EXCEPTION 'the account is not due for deletion' USING ERRCODE = 'P0001';
  END IF;

  IF p_dry_run THEN
    SELECT count(*) INTO n FROM public.requests WHERE user_id = p_user_id;
    c := c || jsonb_build_object('requests', n);
    SELECT count(*) INTO n FROM public.request_events WHERE request_id IN (SELECT id FROM public.requests WHERE user_id = p_user_id);
    c := c || jsonb_build_object('request_events', n);
    SELECT count(*) INTO n FROM public.request_drafts WHERE request_id IN (SELECT id FROM public.requests WHERE user_id = p_user_id);
    c := c || jsonb_build_object('request_drafts', n);
    SELECT count(*) INTO n FROM public.request_replies WHERE request_id IN (SELECT id FROM public.requests WHERE user_id = p_user_id);
    c := c || jsonb_build_object('request_replies', n);
    SELECT count(*) INTO n FROM public.user_companies WHERE user_id = p_user_id;
    c := c || jsonb_build_object('user_companies', n);
    SELECT count(*) INTO n FROM public.inboxes WHERE user_id = p_user_id;
    c := c || jsonb_build_object('inboxes', n);
    SELECT count(*) INTO n FROM public.sessions WHERE user_id = p_user_id;
    c := c || jsonb_build_object('sessions', n);
    RETURN c || jsonb_build_object('done', 0);
  END IF;

  SELECT coalesce(array_agg(id), '{}') INTO req_ids FROM (SELECT id FROM public.requests WHERE user_id = p_user_id ORDER BY id LIMIT p_limit) r;
  DELETE FROM public.request_replies WHERE request_id = ANY (req_ids);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('request_replies', n);
  DELETE FROM public.reply_labels WHERE request_id = ANY (req_ids);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('reply_labels', n);
  DELETE FROM public.request_events WHERE request_id = ANY (req_ids);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('request_events', n);
  DELETE FROM public.request_drafts WHERE request_id = ANY (req_ids);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('request_drafts', n);
  DELETE FROM public.idempotency_keys WHERE request_id = ANY (req_ids);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('idempotency_keys', n);
  DELETE FROM public.request_followups WHERE request_id = ANY (req_ids);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('request_followups', n);
  DELETE FROM public.requests WHERE id = ANY (req_ids);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('requests', n);
  IF EXISTS (SELECT 1 FROM public.requests WHERE user_id = p_user_id) THEN RETURN c || jsonb_build_object('done', 0); END IF;

  DELETE FROM public.idempotency_keys WHERE user_id = p_user_id;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('idempotency_keys', coalesce((c ->> 'idempotency_keys')::int, 0) + n);
  DELETE FROM public.user_companies WHERE id IN (SELECT id FROM public.user_companies WHERE user_id = p_user_id ORDER BY id LIMIT p_limit);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('user_companies', n);
  IF EXISTS (SELECT 1 FROM public.user_companies WHERE user_id = p_user_id) THEN RETURN c || jsonb_build_object('done', 0); END IF;
  DELETE FROM public.scans WHERE id IN (SELECT s.id FROM public.scans s JOIN public.inboxes i ON i.id = s.inbox_id WHERE i.user_id = p_user_id ORDER BY s.id LIMIT p_limit);
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('scans', n);
  IF EXISTS (SELECT 1 FROM public.scans s JOIN public.inboxes i ON i.id = s.inbox_id WHERE i.user_id = p_user_id) THEN RETURN c || jsonb_build_object('done', 0); END IF;
  DELETE FROM public.inboxes WHERE user_id = p_user_id;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('inboxes', n);
  DELETE FROM public.sessions WHERE user_id = p_user_id;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('sessions', n);
  DELETE FROM public.oauth_states WHERE user_id = p_user_id;
  GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('oauth_states', n);

  -- The tombstone keeps the id (random, not personal) and the dates, so history that points at it stays valid. Nothing else:
  -- no email, no name, no Google id, and no hash of any of them.
  UPDATE public.users SET google_sub = 'deleted:' || id, email = '', name = '', status = 'deleting', deleted_at = now(), updated_at = now() WHERE id = p_user_id;
  RETURN c || jsonb_build_object('users_tombstoned', 1, 'done', 1);
END
$$;--> statement-breakpoint
CREATE FUNCTION public.purge_user(p_user_id text, p_limit integer DEFAULT 500, p_dry_run boolean DEFAULT false) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 THEN RAISE EXCEPTION 'batch limit must be 1 to 5000' USING ERRCODE = '22023'; END IF;
  r := public._purge_user_rows(p_user_id, p_limit, coalesce(p_dry_run, false));
  INSERT INTO public.job_runs (id, task, dry_run, counts) VALUES (public._new_job_id(), 'purge_user', coalesce(p_dry_run, false), r);
  RETURN r;
END
$$;--> statement-breakpoint
CREATE FUNCTION public.purge_users(p_limit integer DEFAULT 25, p_dry_run boolean DEFAULT false) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  uid text;
  r jsonb;
  total jsonb := '{}'::jsonb;
  i integer;
  purged integer := 0;
  pending integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN RAISE EXCEPTION 'batch limit must be 1 to 200' USING ERRCODE = '22023'; END IF;
  FOR uid IN SELECT id FROM public.users WHERE status = 'deleting' AND deleted_at IS NULL AND deletion_due_at <= now() ORDER BY deletion_due_at, id LIMIT p_limit LOOP
    FOR i IN 1..10 LOOP
      r := public._purge_user_rows(uid, 1000, coalesce(p_dry_run, false));
      total := public._add_counts(total, r - 'done');
      EXIT WHEN (r ->> 'done')::int = 1 OR p_dry_run;
    END LOOP;
    IF (r ->> 'done')::int = 1 THEN purged := purged + 1; ELSE pending := pending + 1; END IF;
  END LOOP;
  total := total || jsonb_build_object('accounts_purged', purged, 'accounts_unfinished', pending);
  INSERT INTO public.job_runs (id, task, dry_run, counts) VALUES (public._new_job_id(), 'purge_users', coalesce(p_dry_run, false), total);
  RETURN total;
END
$$;--> statement-breakpoint
-- Disconnected inboxes past their retention. Their scans and detected companies go. A detected company a request was made about stays
-- (the request is the person's own record), so its inbox row is kept with the address removed.
CREATE FUNCTION public.purge_inboxes(p_limit integer DEFAULT 100, p_dry_run boolean DEFAULT false) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ibx text;
  n integer;
  c jsonb := jsonb_build_object('scans', 0, 'user_companies', 0, 'inboxes_deleted', 0, 'inboxes_scrubbed', 0);
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'batch limit must be 1 to 1000' USING ERRCODE = '22023'; END IF;
  FOR ibx IN
    SELECT i.id FROM public.inboxes i
    WHERE i.status = 'disconnected' AND i.purge_after <= now() AND i.email NOT LIKE 'purged:%'
    ORDER BY i.purge_after, i.id LIMIT p_limit
  LOOP
    IF p_dry_run THEN
      SELECT count(*) INTO n FROM public.scans WHERE inbox_id = ibx;
      c := public._add_counts(c, jsonb_build_object('scans', n));
      SELECT count(*) INTO n FROM public.user_companies uc WHERE uc.inbox_id = ibx AND NOT EXISTS (SELECT 1 FROM public.requests r WHERE r.user_company_id = uc.id);
      c := public._add_counts(c, jsonb_build_object('user_companies', n));
      CONTINUE;
    END IF;
    DELETE FROM public.scans WHERE inbox_id = ibx;
    GET DIAGNOSTICS n = ROW_COUNT; c := public._add_counts(c, jsonb_build_object('scans', n));
    DELETE FROM public.user_companies uc WHERE uc.inbox_id = ibx AND NOT EXISTS (SELECT 1 FROM public.requests r WHERE r.user_company_id = uc.id);
    GET DIAGNOSTICS n = ROW_COUNT; c := public._add_counts(c, jsonb_build_object('user_companies', n));
    IF EXISTS (SELECT 1 FROM public.user_companies WHERE inbox_id = ibx) THEN
      UPDATE public.inboxes SET email = 'purged:' || id, updated_at = now() WHERE id = ibx;
      c := public._add_counts(c, jsonb_build_object('inboxes_scrubbed', 1));
    ELSE
      DELETE FROM public.inboxes WHERE id = ibx;
      c := public._add_counts(c, jsonb_build_object('inboxes_deleted', 1));
    END IF;
  END LOOP;
  INSERT INTO public.job_runs (id, task, dry_run, counts) VALUES (public._new_job_id(), 'purge_inboxes', coalesce(p_dry_run, false), c);
  RETURN c;
END
$$;--> statement-breakpoint
-- Sessions and sign-in attempts that ended more than a day ago.
CREATE FUNCTION public.purge_sessions(p_limit integer DEFAULT 1000, p_dry_run boolean DEFAULT false) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n integer;
  c jsonb := '{}'::jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN RAISE EXCEPTION 'batch limit must be 1 to 10000' USING ERRCODE = '22023'; END IF;
  IF p_dry_run THEN
    SELECT count(*) INTO n FROM (SELECT 1 FROM public.sessions WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day' LIMIT p_limit) s;
    c := jsonb_build_object('sessions', n);
    SELECT count(*) INTO n FROM (SELECT 1 FROM public.oauth_states WHERE expires_at < now() - interval '1 day' LIMIT p_limit) s;
    c := c || jsonb_build_object('oauth_states', n);
  ELSE
    DELETE FROM public.sessions WHERE id IN (SELECT id FROM public.sessions WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day' ORDER BY id LIMIT p_limit);
    GET DIAGNOSTICS n = ROW_COUNT; c := jsonb_build_object('sessions', n);
    DELETE FROM public.oauth_states WHERE id IN (SELECT id FROM public.oauth_states WHERE expires_at < now() - interval '1 day' ORDER BY id LIMIT p_limit);
    GET DIAGNOSTICS n = ROW_COUNT; c := c || jsonb_build_object('oauth_states', n);
  END IF;
  INSERT INTO public.job_runs (id, task, dry_run, counts) VALUES (public._new_job_id(), 'purge_sessions', coalesce(p_dry_run, false), c);
  RETURN c;
END
$$;--> statement-breakpoint
-- Closed requests older than the retention period. Off unless the caller passes a number of days above zero (REQUEST_RETENTION_DAYS).
CREATE FUNCTION public.purge_requests(p_retention_days integer, p_limit integer DEFAULT 200, p_dry_run boolean DEFAULT false) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ids text[];
  n integer;
  c jsonb := '{}'::jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 2000 THEN RAISE EXCEPTION 'batch limit must be 1 to 2000' USING ERRCODE = '22023'; END IF;
  IF p_retention_days IS NULL OR p_retention_days < 1 THEN RETURN jsonb_build_object('disabled', 1); END IF;
  SELECT coalesce(array_agg(id), '{}') INTO ids FROM (
    SELECT id FROM public.requests WHERE status = 'closed' AND updated_at < now() - make_interval(days => p_retention_days) ORDER BY id LIMIT p_limit) r;
  IF p_dry_run THEN
    c := jsonb_build_object('requests', coalesce(array_length(ids, 1), 0));
  ELSE
    DELETE FROM public.request_replies WHERE request_id = ANY (ids);
    DELETE FROM public.reply_labels WHERE request_id = ANY (ids);
    DELETE FROM public.request_events WHERE request_id = ANY (ids);
    DELETE FROM public.request_drafts WHERE request_id = ANY (ids);
    DELETE FROM public.idempotency_keys WHERE request_id = ANY (ids);
    DELETE FROM public.request_followups WHERE request_id = ANY (ids);
    DELETE FROM public.requests WHERE id = ANY (ids);
    GET DIAGNOSTICS n = ROW_COUNT; c := jsonb_build_object('requests', n);
  END IF;
  INSERT INTO public.job_runs (id, task, dry_run, counts) VALUES (public._new_job_id(), 'purge_requests', coalesce(p_dry_run, false), c);
  RETURN c;
END
$$;--> statement-breakpoint
-- Nobody can run these but the app role. The helpers are not granted at all: the functions above call them as their owner.
REVOKE ALL ON FUNCTION public._new_job_id() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._add_counts(jsonb, jsonb) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public._purge_user_rows(text, integer, boolean) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_user(text, integer, boolean) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_users(integer, boolean) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_inboxes(integer, boolean) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_sessions(integer, boolean) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_requests(integer, integer, boolean) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.purge_user(text, integer, boolean), public.purge_users(integer, boolean), public.purge_inboxes(integer, boolean), public.purge_sessions(integer, boolean), public.purge_requests(integer, integer, boolean) TO erase_app;
