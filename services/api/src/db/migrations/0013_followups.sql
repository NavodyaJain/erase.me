CREATE TYPE "public"."followup_status" AS ENUM('drafted', 'approved', 'sent', 'submitted', 'cancelled');--> statement-breakpoint
CREATE TABLE "request_followups" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"status" "followup_status" DEFAULT 'drafted' NOT NULL,
	"approved_hash" text,
	"sent_at" timestamp with time zone,
	"gmail_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_followups_id_format" CHECK ("request_followups"."id" ~ '^fup_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "request_followups_sequence_range" CHECK ("request_followups"."sequence" between 1 and 3),
	CONSTRAINT "request_followups_approved_hash_format" CHECK ("request_followups"."approved_hash" IS NULL OR "request_followups"."approved_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "request_followups_done_has_time" CHECK ("request_followups"."status" NOT IN ('sent', 'submitted') OR "request_followups"."sent_at" IS NOT NULL),
	CONSTRAINT "request_followups_message_id_format" CHECK ("request_followups"."gmail_message_id" IS NULL OR "request_followups"."gmail_message_id" ~ '^[A-Za-z0-9._-]{1,128}$')
);
--> statement-breakpoint
ALTER TABLE "request_events" DROP CONSTRAINT "request_events_approval_has_hash";--> statement-breakpoint
ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_scope";--> statement-breakpoint
DROP INDEX "request_drafts_request_version_key";--> statement-breakpoint
ALTER TABLE "request_drafts" ADD COLUMN "followup_id" text;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "followup_id" text;--> statement-breakpoint
ALTER TABLE "request_followups" ADD CONSTRAINT "request_followups_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "request_followups_request_sequence_key" ON "request_followups" USING btree ("request_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "request_followups_one_open" ON "request_followups" USING btree ("request_id") WHERE "request_followups"."status" in ('drafted', 'approved');--> statement-breakpoint
CREATE INDEX "request_followups_request_id_idx" ON "request_followups" USING btree ("request_id");--> statement-breakpoint
ALTER TABLE "request_drafts" ADD CONSTRAINT "request_drafts_followup_id_request_followups_id_fk" FOREIGN KEY ("followup_id") REFERENCES "public"."request_followups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_followup_id_request_followups_id_fk" FOREIGN KEY ("followup_id") REFERENCES "public"."request_followups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "request_drafts_followup_version_key" ON "request_drafts" USING btree ("followup_id","version") WHERE "request_drafts"."followup_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "request_drafts_followup_id_idx" ON "request_drafts" USING btree ("followup_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_one_active_followup_send" ON "idempotency_keys" USING btree ("followup_id") WHERE "idempotency_keys"."scope" = 'followup_send' and "idempotency_keys"."status" in ('in_progress', 'completed');--> statement-breakpoint
CREATE UNIQUE INDEX "request_drafts_request_version_key" ON "request_drafts" USING btree ("request_id","version") WHERE "request_drafts"."followup_id" IS NULL;--> statement-breakpoint
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_approval_has_hash" CHECK ("request_events"."type"::text NOT IN ('approved', 'sent', 'followup_approved', 'followup_sent') OR "request_events"."draft_hash" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_followup_scope" CHECK (("idempotency_keys"."scope" = 'followup_send') = ("idempotency_keys"."followup_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_scope" CHECK ("idempotency_keys"."scope" in ('send', 'followup_send'));--> statement-breakpoint

-- A follow-up is mutable while it is worked on (drafted, approved, then sent or submitted), so the app role may update it.
-- Its drafts and events stay append-only.
GRANT SELECT, INSERT, UPDATE ON "request_followups" TO erase_app;--> statement-breakpoint

-- Defence in depth behind the service layer, exactly like migration 0002 for the first request: a follow-up cannot become
-- `sent` (emailed) or `submitted` (pasted into a web form by the person) unless the user approved the current draft of THAT
-- follow-up: a `followup_approved` event by a user, for its latest draft hash, recorded at or after that draft. Editing the
-- draft makes a newer draft, so an earlier approval stops counting.
CREATE FUNCTION "enforce_followup_send_requires_approval"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  latest_hash text;
  latest_at timestamptz;
BEGIN
  IF NEW.status NOT IN ('sent', 'submitted') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('sent', 'submitted') THEN
    RETURN NEW;
  END IF;

  SELECT d.draft_hash, d.created_at INTO latest_hash, latest_at
    FROM request_drafts d
   WHERE d.followup_id = NEW.id
   ORDER BY d.version DESC
   LIMIT 1;

  IF latest_hash IS NULL OR NOT EXISTS (
    SELECT 1
      FROM request_events e
     WHERE e.request_id = NEW.request_id
       AND e.type = 'followup_approved'
       AND e.actor_type = 'user'
       AND e.draft_hash = latest_hash
       AND e.created_at >= latest_at
  ) THEN
    RAISE EXCEPTION 'follow-up % cannot be sent without a user approval of its current draft', NEW.id
      USING ERRCODE = 'check_violation',
            HINT = 'Record a followup_approved event by a user with the current draft_hash first.';
  END IF;

  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER "request_followups_send_requires_approval"
BEFORE INSERT OR UPDATE OF "status" ON "request_followups"
FOR EACH ROW
EXECUTE FUNCTION "enforce_followup_send_requires_approval"();
