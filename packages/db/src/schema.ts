import { pgTable, uuid, text, integer, numeric, boolean, jsonb, timestamp, pgEnum, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Enums
export const trackType = pgEnum('track_type', ['benchmark', 'drip', 'experiment']);
export const runStatus = pgEnum('run_status', ['queued', 'running', 'dead', 'survived', 'failed', 'cancelled']);
export const deathCause = pgEnum('death_cause', [
  'referent_unresolvable',
  'dimensionally_malformed',
  'structure_lost',
  'degenerate_loop',
  'format_failure',
  'attractor_state'
]);

// Models catalog
export const models = pgTable('models', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),
  modelKey: text('model_key').notNull().unique(),
  pinnedVersion: text('pinned_version'),
  displayName: text('display_name').notNull(),
  inputCostPerMtok: numeric('input_cost_per_mtok', { precision: 10, scale: 4 }),
  outputCostPerMtok: numeric('output_cost_per_mtok', { precision: 10, scale: 4 }),
  isActive: boolean('is_active').notNull().default(true),
  metadata: jsonb('metadata').notNull().default({})
});

// Seeds
export const seeds = pgTable('seeds', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  questionText: text('question_text').notNull(),
  domain: text('domain').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// Prompt templates
export const promptTemplates = pgTable('prompt_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  version: integer('version').notNull(),
  body: text('body').notNull(),
  outputSchema: jsonb('output_schema').notNull()
}, (table) => ({
  nameVersionIdx: uniqueIndex('prompt_name_version_idx').on(table.name, table.version)
}));

// Known quantities for groundedness checking
export const knownQuantities = pgTable('known_quantities', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityLabel: text('entity_label').notNull(),
  normalizedKey: text('normalized_key').notNull(), // §3.6 - for better cache hits
  wikidataQid: text('wikidata_qid'),
  value: numeric('value', { precision: 20, scale: 6 }).notNull(),
  unit: text('unit').notNull(),
  dimension: text('dimension').notNull(),
  sourceUrl: text('source_url'),
  confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull().default('1.0'),
  verifiedByHuman: boolean('verified_by_human').notNull().default(false)
}, (table) => ({
  normalizedKeyIdx: uniqueIndex('known_quantities_normalized_key_idx').on(table.normalizedKey, table.unit)
}));

// Runs
export const runs = pgTable('runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  seedId: uuid('seed_id').notNull().references(() => seeds.id),
  modelId: uuid('model_id').notNull().references(() => models.id),
  mutatePromptId: uuid('mutate_prompt_id').notNull().references(() => promptTemplates.id),
  track: trackType('track').notNull(),
  status: runStatus('status').notNull().default('queued'),
  contextDepth: integer('context_depth').notNull().default(5),
  temperature: numeric('temperature', { precision: 3, scale: 2 }), // §3.1 - nullable
  reasoningConfig: jsonb('reasoning_config'), // §3.1 - Claude adaptive thinking, Gemini thinkingBudget
  maxGenerations: integer('max_generations').notNull().default(50),
  replicateIndex: integer('replicate_index').notNull().default(0),
  batchId: uuid('batch_id'),
  deathGeneration: integer('death_generation'), // §3.3 - first generation of failing streak
  censored: boolean('censored').notNull().default(false),
  totalCostUsd: numeric('total_cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  config: jsonb('config').notNull().default({}),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// Questions - the chain spine
export const questions = pgTable('questions', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  genIndex: integer('gen_index').notNull(),
  questionText: text('question_text').notNull(),
  contextWindow: jsonb('context_window').notNull().default([]), // array of question IDs
  rawResponse: jsonb('raw_response'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  latencyMs: integer('latency_ms'),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  runGenIdx: uniqueIndex('questions_run_gen_idx').on(table.runId, table.genIndex)
}));

// Question evaluations
export const questionEvaluations = pgTable('question_evaluations', {
  id: uuid('id').primaryKey().defaultRandom(),
  questionId: uuid('question_id').notNull().references(() => questions.id, { onDelete: 'cascade' }),
  evaluatorVersion: text('evaluator_version').notNull(),

  // Axis 1: referent resolution
  referentsTotal: integer('referents_total').notNull().default(0),
  referentsResolved: integer('referents_resolved').notNull().default(0),
  fabricatedConstants: jsonb('fabricated_constants').notNull().default([]),
  groundedness: numeric('groundedness', { precision: 3, scale: 2 }),

  // Axis 2: dimensional well-formedness
  dimensionA: text('dimension_a'),
  dimensionB: text('dimension_b'),
  comparisonValid: boolean('comparison_valid'),

  // Axis 3: structural preservation
  tripleParsed: boolean('triple_parsed'),
  quantityA: text('quantity_a'),
  relation: text('relation'),
  quantityB: text('quantity_b'),

  // Descriptive (not death triggers)
  driftFromSeed: numeric('drift_from_seed', { precision: 5, scale: 4 }), // §3.4 - 1 - cosine_similarity
  driftFromParent: numeric('drift_from_parent', { precision: 5, scale: 4 }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  questionEvaluatorIdx: uniqueIndex('question_evaluations_question_evaluator_idx').on(table.questionId, table.evaluatorVersion)
}));

// Death events
export const deathEvents = pgTable('death_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  questionId: uuid('question_id').notNull().references(() => questions.id),
  genIndex: integer('gen_index').notNull(),
  cause: deathCause('cause').notNull(),
  evaluatorVersion: text('evaluator_version').notNull(),
  evidence: jsonb('evidence').notNull().default({}),
  humanConfirmed: boolean('human_confirmed'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => ({
  runEvaluatorIdx: uniqueIndex('death_events_run_evaluator_idx').on(table.runId, table.evaluatorVersion)
}));
