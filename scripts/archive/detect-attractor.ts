#!/usr/bin/env tsx
/**
 * Detect attractor states - semantic collapse to a repetitive pattern
 *
 * Attractor criteria:
 * - 8+ consecutive generations with mean drift-from-parent < 0.45
 * - AND standard deviation of drift-from-parent < 0.10 (low variance)
 * - Indicates the model is stuck in a semantic basin
 */

import { db } from './packages/db/src/client.js';
import { questions, questionEvaluations, deathEvents, runs } from './packages/db/src/schema.js';
import { createGateway } from './packages/gateway/src/index-fetch.js';
import { generateEmbedding, calculateDrift } from './packages/gateway/src/embeddings.js';
import { eq, desc, asc } from 'drizzle-orm';
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

interface QuestionData {
  id: string;
  genIndex: number;
  questionText: string;
  embedding: number[];
  evaluation: ExtractStructureOutput;
  driftFromSeed?: number;
  driftFromParent?: number;
}

function calculateStats(values: number[]): { mean: number; stdDev: number } {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  return { mean, stdDev };
}

async function detectAttractor(runId: string) {
  console.log('🔍 Detecting attractor states with drift analysis...\n');
  console.log(`Run ID: ${runId}\n`);

  // Get all questions for this run
  const allQuestionsRaw = await db
    .select()
    .from(questions)
    .where(eq(questions.runId, runId))
    .orderBy(asc(questions.genIndex));

  console.log(`Found ${allQuestionsRaw.length} questions\n`);

  const gateway = createGateway();
  const questionsWithData: QuestionData[] = [];

  let deathGen: number | null = null;
  let deathCause: string | null = null;

  // Process each question in order
  for (const question of allQuestionsRaw) {
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
      evaluatorVersion: 'attractor-v1',
      referentsTotal: evaluation.referents.length,
      referentsResolved: 0,
      fabricatedConstants: [],
      groundedness: null,
      dimensionA: evaluation.dimension_a,
      dimensionB: evaluation.dimension_b,
      comparisonValid: evaluation.dimension_a === evaluation.dimension_b,
      tripleParsed: !evaluation.parse_failed,
      quantityA: evaluation.quantity_a,
      relation: evaluation.relation,
      quantityB: evaluation.quantity_b,
      driftFromSeed: driftFromSeed ? String(driftFromSeed) : null,
      driftFromParent: driftFromParent ? String(driftFromParent) : null
    }).onConflictDoUpdate({
      target: [questionEvaluations.questionId],
      set: {
        evaluatorVersion: 'attractor-v1',
        driftFromSeed: driftFromSeed ? String(driftFromSeed) : null,
        driftFromParent: driftFromParent ? String(driftFromParent) : null
      }
    });

    console.log(`  ✓ Drift from seed: ${driftFromSeed?.toFixed(4) ?? 'N/A'}, from parent: ${driftFromParent?.toFixed(4) ?? 'N/A'}`);

    // Check for death after we have enough generations
    if (deathGen === null && question.genIndex >= 8) {
      // Check for attractor state: 8 consecutive generations with low mean drift and low variance
      const last8 = questionsWithData.slice(-8);
      const driftValues = last8.map(q => q.driftFromParent).filter((d): d is number => d !== undefined);

      if (driftValues.length === 8) {
        const stats = calculateStats(driftValues);

        if (stats.mean < 0.45 && stats.stdDev < 0.10) {
          deathGen = last8[0].genIndex; // §3.3: first of the streak
          deathCause = 'attractor_state';
          console.log(`\n💀 Attractor state detected at gen ${deathGen}!`);
          console.log(`   Gens ${last8[0].genIndex}-${last8[7].genIndex}:`);
          console.log(`   Mean drift: ${stats.mean.toFixed(4)}, StdDev: ${stats.stdDev.toFixed(4)}`);
          for (const q of last8) {
            console.log(`   Gen ${q.genIndex}: drift = ${q.driftFromParent?.toFixed(4)}`);
          }
          // Continue processing to see the full pattern
        }
      }

      // Check for degenerate loop: drift < 0.02 for 4 consecutive generations
      const last4 = questionsWithData.slice(-4);
      if (last4.length === 4 && last4.every(q => q.driftFromParent !== undefined && q.driftFromParent < 0.02)) {
        if (deathGen === null) {
          deathGen = last4[0].genIndex;
          deathCause = 'degenerate_loop';
          console.log(`\n💀 Degenerate loop detected at gen ${deathGen}!`);
        }
      }

      // Also check for structure_lost
      if (evaluation.parse_failed) {
        if (question.genIndex > 0 && questionsWithData[questionsWithData.length - 2].evaluation.parse_failed) {
          if (deathGen === null) {
            deathGen = question.genIndex - 1;
            deathCause = 'structure_lost';
            console.log(`\n💀 Structure lost at gen ${deathGen}!`);
          }
        }
      }
    }
  }

  // Record death event if found
  if (deathGen !== null && deathCause) {
    const deadQuestion = questionsWithData[deathGen];
    const windowStart = Math.max(0, deathGen - 2);
    const windowEnd = Math.min(questionsWithData.length, deathGen + 8);
    const evidenceWindow = questionsWithData.slice(windowStart, windowEnd);

    await db.insert(deathEvents).values({
      runId,
      questionId: deadQuestion.id,
      genIndex: deathGen,
      cause: deathCause as any,
      evaluatorVersion: 'attractor-v1',
      evidence: {
        driftValues: evidenceWindow.map(q => ({
          gen: q.genIndex,
          driftFromParent: q.driftFromParent,
          driftFromSeed: q.driftFromSeed
        })),
        attractorStats: deathCause === 'attractor_state' ? {
          window: evidenceWindow.map(q => q.questionText),
          mean: calculateStats(evidenceWindow.map(q => q.driftFromParent).filter((d): d is number => d !== undefined)).mean,
          stdDev: calculateStats(evidenceWindow.map(q => q.driftFromParent).filter((d): d is number => d !== undefined)).stdDev
        } : undefined
      }
    }).onConflictDoUpdate({
      target: [deathEvents.runId],
      set: {
        questionId: deadQuestion.id,
        genIndex: deathGen,
        cause: deathCause as any,
        evaluatorVersion: 'attractor-v1',
        evidence: {
          driftValues: evidenceWindow.map(q => ({
            gen: q.genIndex,
            driftFromParent: q.driftFromParent,
            driftFromSeed: q.driftFromSeed
          })),
          attractorStats: deathCause === 'attractor_state' ? {
            window: evidenceWindow.map(q => q.questionText),
            mean: calculateStats(evidenceWindow.map(q => q.driftFromParent).filter((d): d is number => d !== undefined)).mean,
            stdDev: calculateStats(evidenceWindow.map(q => q.driftFromParent).filter((d): d is number => d !== undefined)).stdDev
          } : undefined
        }
      }
    });

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

    if (deathCause === 'attractor_state') {
      console.log('\n📊 Attractor Pattern (8-generation window):');
      const start = deathGen;
      const end = Math.min(deathGen + 8, questionsWithData.length);
      for (let i = start; i < end; i++) {
        console.log(`  Gen ${i}: ${questionsWithData[i].questionText}`);
      }
    }
  } else {
    console.log('\n' + '='.repeat(60));
    console.log('\n✅ Chain survived all generations!');
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

  await detectAttractor(latestRun.id);
}

main().catch(err => {
  console.error('Detection failed:', err);
  process.exit(1);
});
