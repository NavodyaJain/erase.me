CREATE TABLE "request_replies" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"gmail_message_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"sender_domain" text,
	"sender_match" "reply_sender_match" NOT NULL,
	"automatic" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_replies_id_format" CHECK ("request_replies"."id" ~ '^rpl_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "request_replies_message_id_format" CHECK ("request_replies"."gmail_message_id" ~ '^[A-Za-z0-9._-]{1,128}$'),
	CONSTRAINT "request_replies_domain_only" CHECK ("request_replies"."sender_domain" IS NULL OR (char_length("request_replies"."sender_domain") <= 253 AND "request_replies"."sender_domain" ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'))
);
--> statement-breakpoint
ALTER TABLE "requests" DROP CONSTRAINT "requests_sent_has_details";--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "channel" "request_channel" DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "sent_message_id" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "sent_rfc_message_id" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "reply_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "reply_check_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "first_reply_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "request_replies" ADD CONSTRAINT "request_replies_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "request_replies_request_message_key" ON "request_replies" USING btree ("request_id","gmail_message_id");--> statement-breakpoint
CREATE INDEX "request_replies_request_id_idx" ON "request_replies" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "requests_reply_poll_idx" ON "requests" USING btree ("status","reply_checked_at");--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_form_has_no_thread" CHECK ("requests"."channel" = 'email' OR "requests"."thread_id" IS NULL);--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_reply_check_failures_nonneg" CHECK ("requests"."reply_check_failures" >= 0);--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_sent_has_details" CHECK ("requests"."status" in ('drafted', 'approved', 'closed', 'bounced') OR ("requests"."sent_at" IS NOT NULL AND "requests"."due_at" IS NOT NULL AND ("requests"."thread_id" IS NOT NULL OR "requests"."channel" = 'web_form')));--> statement-breakpoint

-- The app role can add and read replies. It cannot change or delete them: like request_events, they are a record.
GRANT SELECT, INSERT ON "request_replies" TO erase_app;
