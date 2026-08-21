#!/usr/bin/env tsx
/**
 * Re-evaluate existing questions with full drift + degenerate loop detection
 */

import { db } from './packages/db/src/client.js';
import { questions, questionEvaluations, deathEvents, runs } from './packages/db/src/schema.js';
import { createGateway } from './packages/gateway/src/index-fetch.js';
import { generateEmbedding, calculateDrift } from './packages/gateway/src/embeddings.js';
import { eq, and, asc, desc } from 'drizzle-orm';
import { z } from 'zod';

const ExtractStructureSchema = z.object({
  quantity_a: z.string(),
  dimension_a: z.enum(['energy', 'mass', 'time', 'distance', 'power', 'volume', 'count', 'rate', 'unknown']),
  relation: z.string(),
  quantity_b: z.string(),
  dimension_b: z.enum(['energy', 'mass', 'time', 'distance', 'power', 'volume', 'count', 'rate', 'unknown']),
  referents: z.array(z.object({
    label: z.string(),
    needed_dimension: z.string()
  })),
  parse_failed: z.boolean()
});

type ExtractStructureOutput = z.infer<typeof ExtractStructureSchema>;

interface QuestionWithEmbedding {
  id: string;
  genIndex: number;
  questionText: string;
  embedding: number[];
  evaluation: ExtractStructureOutput;
  driftFromSeed?: number;
  driftFromParent?: number;
}

async function evaluateRun(runId: string) {
  console.log('🔍 Re-evaluating run with full drift detection...\n');
  console.log(`Run ID: ${runId}\n`);

  // Get all questions for this run
  const allQuestions = await db
    .select()
    .from(questions)
    .where(eq(questions.runId, runId))
    .orderBy(asc(questions.genIndex));

  console.log(`Found ${allQuestions.length} questions\n`);

  const gateway = createGateway();
  const questionsWithData: QuestionWithEmbedding[] = [];

  // Process each question
  for (const question of allQuestions) {
    console.log(`Processing gen ${question.genIndex}: ${question.questionText.substring(0, 80)}...`);

    // Generate embedding
    const embedding = await generateEmbedding(question.questionText);

    // Extract structure
    const extractPrompt = `Extract the quantitative structure of this comparison question:

${question.questionText}

Identify:
- the two quantities being compared
- the physical dimension of each (energy, mass, time, distance, power, volume, count, rate, or unknown)
- every named entity whose real-world measured value is needed to answer it

List an entity even if you are unsure it exists. Do not correct, improve, or comment on the question. Do not answer it.`;

    const response = await gateway.generate({
      systemPrompt: 'You extract the quantitative structure of a comparison question.\n\nList an entity even if you are unsure it exists. Do not correct, improve, or comment on the question. Do not answer it.\n\nRespond with JSON only.',
      userPrompt: extractPrompt,
      schema: ExtractStructureSchema
    });

    const evaluation = response.parsed as ExtractStructureOutput;

    // Calculate drift
    let driftFromSeed: number | undefined;
    let driftFromParent: number | undefined;

    if (question.genIndex > 0 && questionsWithData.length > 0) {
      const seedEmbedding = questionsWithData[0].embedding;
      driftFromSeed = calculateDrift(embedding, seedEmbedding);

      const parentEmbedding = questionsWithData[questionsWithData.length - 1].embedding;
      driftFromParent = calculateDrift(embedding, parentEmbedding);
    }

    questionsWithData.push({
      id: question.id,
      genIndex: question.genIndex,
      questionText: question.questionText,
      embedding,
      evaluation,
      driftFromSeed,
      driftFromParent
    });

    // Save evaluation to database
    await db.insert(questionEvaluations).values({
      questionId: question.id,
      evaluatorVersion: 'drift-v1',
      referentsTotal: evaluation.referents.length,
      referentsResolved: 0, // We're not doing full groundedness check yet
      fabricatedConstants: [],
      groundedness: null,
      dimensionA: evaluation.dimension_a,
      dimensionB: evaluation.dimension_b,
      comparisonValid: evaluation.dimension_a === evaluation.dimension_b, // Simple check
      tripleParsed: !evaluation.parse_failed,
      quantityA: evaluation.quantity_a,
      relation: evaluation.relation,
      quantityB: evaluation.quantity_b,
      driftFromSeed: driftFromSeed ? String(driftFromSeed) : null,
      driftFromParent: driftFromParent ? String(driftFromParent) : null
    }).onConflictDoNothing();

    console.log(`  ✓ Drift from seed: ${driftFromSeed?.toFixed(4) ?? 'N/A'}, from parent: ${driftFromParent?.toFixed(4) ?? 'N/A'}`);
  }

  // Detect degenerate loop
  console.log('\n📊 Analyzing for degenerate loop...\n');

  let deathGen: number | null = null;
  let deathCause: string | null = null;

  // §3.3: death_generation = first generation of failing streak
  // Degenerate loop: drift_from_parent < 0.02 for 4 consecutive generations
  for (let i = 4; i < questionsWithData.length; i++) {
    const last4 = questionsWithData.slice(i - 3, i + 1);

    const allLowDrift = last4.every(q =>
      q.driftFromParent !== undefined && q.driftFromParent < 0.02
    );

    if (allLowDrift) {
      deathGen = last4[0].genIndex; // First of the streak
      deathCause = 'degenerate_loop';
      console.log(`💀 Degenerate loop detected at gen ${deathGen}!`);
      console.log(`   Gens ${last4[0].genIndex}-${last4[3].genIndex} all have drift < 0.02`);

      for (const q of last4) {
        console.log(`   Gen ${q.genIndex}: drift = ${q.driftFromParent?.toFixed(4)}`);
      }

      break;
    }

    // Also check for structure_lost
    if (questionsWithData[i].evaluation.parse_failed) {
      if (i > 0 && questionsWithData[i - 1].evaluation.parse_failed) {
        deathGen = i - 1; // First of the streak
        deathCause = 'structure_lost';
        console.log(`💀 Structure lost at gen ${deathGen}!`);
        break;
      }
    }
  }

  if (deathGen !== null && deathCause) {
    // Record death event
    await db.insert(deathEvents).values({
      runId,
      questionId: questionsWithData[deathGen].id,
      genIndex: deathGen,
      cause: deathCause as any,
      evaluatorVersion: 'drift-v1',
      evidence: {
        driftValues: questionsWithData.slice(Math.max(0, deathGen - 1), deathGen + 4)
          .map(q => ({ gen: q.genIndex, driftFromParent: q.driftFromParent }))
      }
    }).onConflictDoNothing();

    // Update run
    await db.update(runs)
      .set({
        status: 'dead',
        deathGeneration: deathGen,
        censored: false
      })
      .where(eq(runs.id, runId));

    console.log(`\n🎯 Death recorded at generation ${deathGen}`);
  } else {
    console.log('\n✅ No death detected - chain survived!');

    await db.update(runs)
      .set({
        status: 'survived',
        censored: true
      })
      .where(eq(runs.id, runId));
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('\n📈 DRIFT ANALYSIS SUMMARY\n');
  console.log('Gen | Drift from Seed | Drift from Parent | Status');
  console.log('-'.repeat(60));

  for (const q of questionsWithData) {
    const seedDrift = q.driftFromSeed?.toFixed(4) ?? '  N/A  ';
    const parentDrift = q.driftFromParent?.toFixed(4) ?? '  N/A  ';
    const status = deathGen !== null && q.genIndex >= deathGen ? '💀' : '✅';
    console.log(`${String(q.genIndex).padStart(3)} | ${seedDrift.padStart(15)} | ${parentDrift.padStart(17)} | ${status}`);
  }

  if (deathGen !== null) {
    console.log('\n' + '='.repeat(60));
    console.log(`\n💀 DEATH DETECTED at generation ${deathGen}`);
    console.log(`Cause: ${deathCause}`);
    console.log('\nDead question:');
    console.log(`  "${questionsWithData[deathGen].questionText}"`);
  } else {
    console.log('\n' + '='.repeat(60));
    console.log('\n✅ Chain survived all 50 generations!');
  }

  console.log('\n' + '='.repeat(60) + '\n');

  process.exit(0);
}

async function main() {
  // Get the most recent run
  const [latestRun] = await db.select().from(runs).orderBy(desc(runs.createdAt)).limit(1);

  if (!latestRun) {
    console.error('No runs found!');
    process.exit(1);
  }

  await evaluateRun(latestRun.id);
}

main().catch(err => {
  console.error('Evaluation failed:', err);
  process.exit(1);
});
