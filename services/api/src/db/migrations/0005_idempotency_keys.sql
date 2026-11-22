CREATE TABLE "idempotency_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_id" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"response_status" integer,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "idempotency_keys_id_format" CHECK ("idempotency_keys"."id" ~ '^idk_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "idempotency_keys_scope" CHECK ("idempotency_keys"."scope" in ('send')),
	CONSTRAINT "idempotency_keys_status" CHECK ("idempotency_keys"."status" in ('in_progress', 'completed', 'failed')),
	CONSTRAINT "idempotency_keys_key_length" CHECK (char_length("idempotency_keys"."key") between 8 and 128),
	CONSTRAINT "idempotency_keys_completed_has_response" CHECK ("idempotency_keys"."status" <> 'completed' OR ("idempotency_keys"."response" IS NOT NULL AND "idempotency_keys"."response_status" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_user_scope_key" ON "idempotency_keys" USING btree ("user_id","scope","key");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_one_active_send" ON "idempotency_keys" USING btree ("request_id") WHERE "idempotency_keys"."scope" = 'send' and "idempotency_keys"."status" in ('in_progress', 'completed');