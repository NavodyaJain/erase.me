CREATE TYPE "public"."reply_sender_match" AS ENUM('company', 'other', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."request_channel" AS ENUM('email', 'web_form');--> statement-breakpoint
ALTER TYPE "public"."request_event_type" ADD VALUE 'reply_received';--> statement-breakpoint
ALTER TYPE "public"."request_event_type" ADD VALUE 'outcome_set';--> statement-breakpoint
ALTER TYPE "public"."request_event_type" ADD VALUE 'followup_approved';--> statement-breakpoint
ALTER TYPE "public"."request_event_type" ADD VALUE 'followup_sent';--> statement-breakpoint
ALTER TYPE "public"."request_event_type" ADD VALUE 'submitted';--> statement-breakpoint
ALTER TYPE "public"."request_status" ADD VALUE 'reply_received' BEFORE 'replied_deleted';