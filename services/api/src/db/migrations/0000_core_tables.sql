CREATE TYPE "public"."actor_type" AS ENUM('user', 'system', 'admin');--> statement-breakpoint
CREATE TYPE "public"."company_category" AS ENUM('loan_app', 'wallet_payments', 'broker_investing', 'credit', 'ecommerce', 'travel', 'streaming', 'education', 'social', 'saas', 'other');--> statement-breakpoint
CREATE TYPE "public"."draft_author" AS ENUM('template', 'ai', 'user');--> statement-breakpoint
CREATE TYPE "public"."grievance_status" AS ENUM('unknown', 'verified', 'bounced');--> statement-breakpoint
CREATE TYPE "public"."inbox_status" AS ENUM('connected', 'disconnected', 'error');--> statement-breakpoint
CREATE TYPE "public"."reply_label" AS ENUM('deleted', 'info_requested', 'refused', 'other');--> statement-breakpoint
CREATE TYPE "public"."reply_label_source" AS ENUM('model', 'admin');--> statement-breakpoint
CREATE TYPE "public"."request_event_type" AS ENUM('drafted', 'edited', 'approved', 'sent', 'bounced', 'reply_label', 'followup_drafted', 'closed');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('drafted', 'approved', 'sent', 'replied_deleted', 'replied_info_requested', 'replied_refused', 'no_reply', 'closed', 'bounced');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('high', 'medium', 'low', 'must_keep');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."user_company_status" AS ENUM('active', 'not_mine', 'requested');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'deleting');--> statement-breakpoint
CREATE TABLE "inboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"provider" text DEFAULT 'gmail' NOT NULL,
	"status" "inbox_status" DEFAULT 'connected' NOT NULL,
	"token_ciphertext" text,
	"token_key_id" text,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"last_scan_at" timestamp with time zone,
	"purge_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inboxes_id_user_key" UNIQUE("id","user_id"),
	CONSTRAINT "inboxes_id_format" CHECK ("inboxes"."id" ~ '^inb_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "inboxes_provider_gmail" CHECK ("inboxes"."provider" = 'gmail'),
	CONSTRAINT "inboxes_connected_has_token" CHECK ("inboxes"."status" <> 'connected' OR ("inboxes"."token_ciphertext" IS NOT NULL AND "inboxes"."token_key_id" IS NOT NULL)),
	CONSTRAINT "inboxes_disconnected_dropped_token" CHECK ("inboxes"."status" <> 'disconnected' OR ("inboxes"."token_ciphertext" IS NULL AND "inboxes"."disconnected_at" IS NOT NULL AND "inboxes"."purge_after" IS NOT NULL)),
	CONSTRAINT "inboxes_purge_needs_disconnect" CHECK ("inboxes"."purge_after" IS NULL OR "inboxes"."disconnected_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "scans" (
	"id" text PRIMARY KEY NOT NULL,
	"inbox_id" text NOT NULL,
	"status" "scan_status" DEFAULT 'queued' NOT NULL,
	"progress_pct" integer DEFAULT 0 NOT NULL,
	"found_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cursor" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scans_id_format" CHECK ("scans"."id" ~ '^scn_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "scans_progress_range" CHECK ("scans"."progress_pct" between 0 and 100),
	CONSTRAINT "scans_found_count_nonneg" CHECK ("scans"."found_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"google_sub" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_id_format" CHECK ("users"."id" ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"category" "company_category" DEFAULT 'other' NOT NULL,
	"grievance_email" text,
	"grievance_source" text,
	"grievance_verified_on" date,
	"grievance_status" "grievance_status" DEFAULT 'unknown' NOT NULL,
	"is_fictional" boolean DEFAULT false NOT NULL,
	"cancel_url" text,
	"must_keep" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_id_format" CHECK ("companies"."id" ~ '^cmp_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "companies_slug_format" CHECK ("companies"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "companies_grievance_email_format" CHECK ("companies"."grievance_email" IS NULL OR "companies"."grievance_email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
	CONSTRAINT "companies_grievance_provenance" CHECK ("companies"."grievance_email" IS NULL OR ("companies"."grievance_source" IS NOT NULL AND "companies"."grievance_verified_on" IS NOT NULL)),
	CONSTRAINT "companies_verified_has_email" CHECK ("companies"."grievance_status" <> 'verified' OR "companies"."grievance_email" IS NOT NULL),
	CONSTRAINT "companies_fictional_example_only" CHECK (NOT "companies"."is_fictional" OR "companies"."grievance_email" IS NULL OR "companies"."grievance_email" ~* '@example\.com$'),
	CONSTRAINT "companies_real_not_example" CHECK ("companies"."is_fictional" OR "companies"."grievance_email" IS NULL OR "companies"."grievance_email" !~* '@example\.com$')
);
--> statement-breakpoint
CREATE TABLE "user_companies" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"company_id" text NOT NULL,
	"inbox_id" text NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"signal_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"risk_level" "risk_level",
	"holds_hint" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "user_company_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_companies_id_user_key" UNIQUE("id","user_id"),
	CONSTRAINT "user_companies_id_format" CHECK ("user_companies"."id" ~ '^ucm_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "user_companies_seen_order" CHECK ("user_companies"."last_seen" >= "user_companies"."first_seen")
);
--> statement-breakpoint
CREATE TABLE "reply_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"label" "reply_label" NOT NULL,
	"confidence" numeric(3, 2) NOT NULL,
	"signals" text[] DEFAULT '{}'::text[] NOT NULL,
	"source" "reply_label_source" NOT NULL,
	"confirmed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_labels_id_format" CHECK ("reply_labels"."id" ~ '^rlb_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "reply_labels_confidence_range" CHECK ("reply_labels"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "request_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"version" integer NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"draft_hash" text NOT NULL,
	"created_by" "draft_author" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_drafts_id_format" CHECK ("request_drafts"."id" ~ '^drf_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "request_drafts_version_positive" CHECK ("request_drafts"."version" >= 1),
	CONSTRAINT "request_drafts_hash_format" CHECK ("request_drafts"."draft_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "request_drafts_body_size" CHECK (char_length("request_drafts"."body") between 1 and 20000)
);
--> statement-breakpoint
CREATE TABLE "request_events" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"type" "request_event_type" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"draft_hash" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_events_id_format" CHECK ("request_events"."id" ~ '^evt_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "request_events_hash_format" CHECK ("request_events"."draft_hash" IS NULL OR "request_events"."draft_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "request_events_approval_has_hash" CHECK ("request_events"."type" NOT IN ('approved', 'sent') OR "request_events"."draft_hash" IS NOT NULL),
	CONSTRAINT "request_events_payload_object" CHECK (jsonb_typeof("request_events"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"user_company_id" text NOT NULL,
	"status" "request_status" DEFAULT 'drafted' NOT NULL,
	"thread_id" text,
	"sent_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"day30_followup_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requests_id_format" CHECK ("requests"."id" ~ '^req_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "requests_sent_has_details" CHECK ("requests"."status" in ('drafted', 'approved', 'closed', 'bounced') OR ("requests"."sent_at" IS NOT NULL AND "requests"."thread_id" IS NOT NULL AND "requests"."due_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"role" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"reason" text,
	"ip" "inet",
	"request_id" text,
	CONSTRAINT "audit_log_id_format" CHECK ("audit_log"."id" ~ '^aud_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "inboxes" ADD CONSTRAINT "inboxes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_companies" ADD CONSTRAINT "user_companies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_companies" ADD CONSTRAINT "user_companies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_companies" ADD CONSTRAINT "user_companies_inbox_owner_fk" FOREIGN KEY ("inbox_id","user_id") REFERENCES "public"."inboxes"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_labels" ADD CONSTRAINT "reply_labels_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_drafts" ADD CONSTRAINT "request_drafts_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_user_company_owner_fk" FOREIGN KEY ("user_company_id","user_id") REFERENCES "public"."user_companies"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inboxes_user_email_key" ON "inboxes" USING btree ("user_id","email");--> statement-breakpoint
CREATE INDEX "inboxes_user_id_idx" ON "inboxes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scans_inbox_id_idx" ON "scans" USING btree ("inbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scans_one_active_per_inbox" ON "scans" USING btree ("inbox_id") WHERE "scans"."status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_sub_key" ON "users" USING btree ("google_sub");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_slug_key" ON "companies" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "companies_domains_gin" ON "companies" USING gin ("domains");--> statement-breakpoint
CREATE INDEX "companies_category_idx" ON "companies" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "user_companies_user_company_key" ON "user_companies" USING btree ("user_id","company_id");--> statement-breakpoint
CREATE INDEX "user_companies_user_id_idx" ON "user_companies" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_companies_company_id_idx" ON "user_companies" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "user_companies_inbox_id_idx" ON "user_companies" USING btree ("inbox_id");--> statement-breakpoint
CREATE INDEX "reply_labels_request_id_idx" ON "reply_labels" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "request_drafts_request_version_key" ON "request_drafts" USING btree ("request_id","version");--> statement-breakpoint
CREATE INDEX "request_events_request_created_idx" ON "request_events" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE INDEX "requests_user_id_idx" ON "requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "requests_status_due_at_idx" ON "requests" USING btree ("status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "requests_one_open_per_user_company" ON "requests" USING btree ("user_company_id") WHERE "requests"."status" not in ('closed', 'bounced');--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_type","actor_id");