ALTER TYPE "public"."death_cause" ADD VALUE 'template_lock';--> statement-breakpoint
ALTER TYPE "public"."death_cause" ADD VALUE 'dimension_collapse';--> statement-breakpoint
ALTER TABLE "question_evaluations" ADD COLUMN "relation_repeat_6" integer;--> statement-breakpoint
ALTER TABLE "question_evaluations" ADD COLUMN "template_share_10" numeric(3, 2);--> statement-breakpoint
ALTER TABLE "question_evaluations" ADD COLUMN "dimension_entropy_10" numeric(4, 3);--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "relation_normalized" text;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "template_signature" text;