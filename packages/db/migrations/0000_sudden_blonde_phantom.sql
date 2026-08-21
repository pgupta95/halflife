CREATE TYPE "public"."death_cause" AS ENUM('referent_unresolvable', 'dimensionally_malformed', 'structure_lost', 'degenerate_loop', 'format_failure');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'dead', 'survived', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."track_type" AS ENUM('benchmark', 'drip', 'experiment');--> statement-breakpoint
CREATE TABLE "death_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"gen_index" integer NOT NULL,
	"cause" "death_cause" NOT NULL,
	"evaluator_version" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"human_confirmed" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "known_quantities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_label" text NOT NULL,
	"normalized_key" text NOT NULL,
	"wikidata_qid" text,
	"value" numeric(20, 6) NOT NULL,
	"unit" text NOT NULL,
	"dimension" text NOT NULL,
	"source_url" text,
	"confidence" numeric(3, 2) DEFAULT '1.0' NOT NULL,
	"verified_by_human" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model_key" text NOT NULL,
	"pinned_version" text,
	"display_name" text NOT NULL,
	"input_cost_per_mtok" numeric(10, 4),
	"output_cost_per_mtok" numeric(10, 4),
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "models_model_key_unique" UNIQUE("model_key")
);
--> statement-breakpoint
CREATE TABLE "prompt_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"output_schema" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"evaluator_version" text NOT NULL,
	"referents_total" integer DEFAULT 0 NOT NULL,
	"referents_resolved" integer DEFAULT 0 NOT NULL,
	"fabricated_constants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"groundedness" numeric(3, 2),
	"dimension_a" text,
	"dimension_b" text,
	"comparison_valid" boolean,
	"triple_parsed" boolean,
	"quantity_a" text,
	"relation" text,
	"quantity_b" text,
	"drift_from_seed" numeric(5, 4),
	"drift_from_parent" numeric(5, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"gen_index" integer NOT NULL,
	"question_text" text NOT NULL,
	"context_window" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_response" jsonb,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"latency_ms" integer,
	"cost_usd" numeric(10, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seed_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"mutate_prompt_id" uuid NOT NULL,
	"track" "track_type" NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"context_depth" integer DEFAULT 5 NOT NULL,
	"temperature" numeric(3, 2),
	"reasoning_config" jsonb,
	"max_generations" integer DEFAULT 50 NOT NULL,
	"replicate_index" integer DEFAULT 0 NOT NULL,
	"batch_id" uuid,
	"death_generation" integer,
	"censored" boolean DEFAULT false NOT NULL,
	"total_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"question_text" text NOT NULL,
	"domain" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seeds_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "death_events" ADD CONSTRAINT "death_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_events" ADD CONSTRAINT "death_events_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_evaluations" ADD CONSTRAINT "question_evaluations_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_seed_id_seeds_id_fk" FOREIGN KEY ("seed_id") REFERENCES "public"."seeds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_mutate_prompt_id_prompt_templates_id_fk" FOREIGN KEY ("mutate_prompt_id") REFERENCES "public"."prompt_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "death_events_run_evaluator_idx" ON "death_events" USING btree ("run_id","evaluator_version");--> statement-breakpoint
CREATE UNIQUE INDEX "known_quantities_normalized_key_idx" ON "known_quantities" USING btree ("normalized_key","unit");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_name_version_idx" ON "prompt_templates" USING btree ("name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "question_evaluations_question_evaluator_idx" ON "question_evaluations" USING btree ("question_id","evaluator_version");--> statement-breakpoint
CREATE UNIQUE INDEX "questions_run_gen_idx" ON "questions" USING btree ("run_id","gen_index");