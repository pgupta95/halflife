#!/usr/bin/env tsx
/**
 * Round 2 Evaluator - Deterministic Template Detection
 *
 * Replaces embedding-based attractor detection with:
 * 1. Relation repetition (5 of last 6)
 * 2. Template dominance (60%+ of last 10)
 * 3. Dimension entropy collapse (< 0.8 bits)
 */

import { db } from '../packages/db/src/client.js';
import { questions, questionEvaluations, deathEvents, runs } from '../packages/db/src/schema.js';
import { createGateway } from '../packages/gateway/src/index-fetch.js';
import { generateEmbedding, calculateDrift } from '../packages/gateway/src/embeddings.js';
import { normalizeRelation, isUnknownRelation } from '../packages/gateway/src/relation-normalizer.js';
import {
  generateTemplateSignature,
  runAllDetectors,
  type QuestionMetrics
} from '../packages/gateway/src/template-detectors.js';
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

interface QuestionData extends QuestionMetrics {
  id: string;
  questionText: string;
  embedding?: number[];
  evaluation?: ExtractStructureOutput;
  driftFromSeed?: number;
  driftFromParent?: number;
}

async function evaluateRound2(runId: string) {
  console.log('🔍 Round 2 Evaluation - Deterministic Template Detection\n');
  console.log(`Run ID: ${runId}\n`);

  const allQuestionsRaw = await db
    .select()
    .from(questions)
    .where(eq(questions.runId, runId))
    .orderBy(asc(questions.genIndex));

  console.log(`Found ${allQuestionsRaw.length} questions\n`);

  const gateway = createGateway();
  const questionsWithData: QuestionData[] = [];
  const unknownRelations = new Set<string>();

  let deathGen: number | null = null;
  let deathCause: string | null = null;
  let deathEvidence: any = null;

  // Process each question
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

    // Normalize relation and generate template signature
    const relationNormalized = normalizeRelation(evaluation.relation);
    const templateSignature = generateTemplateSignature(
      evaluation.dimension_a,
      relationNormalized,
      evaluation.dimension_b
    );

    if (isUnknownRelation(relationNormalized)) {
      unknownRelations.add(`${relationNormalized} (from: "${evaluation.relation}")`);
    }

    // Calculate drift
    let driftFromSeed: number | undefined;
    let driftFromParent: number | undefined;

    if (question.genIndex > 0 && questionsWithData.length > 0) {
      const seedEmbedding = questionsWithData[0].embedding!;
      driftFromSeed = calculateDrift(embedding, seedEmbedding);

      const parentEmbedding = questionsWithData[questionsWithData.length - 1].embedding!;
      driftFromParent = calculateDrift(embedding, parentEmbedding);
    }

    // Update question with normalized data
    await db.update(questions).set({
      relationNormalized,
      templateSignature
    }).where(eq(questions.id, question.id));

    // Build question data
    const questionData: QuestionData = {
      id: question.id,
      genIndex: question.genIndex,
      questionText: question.questionText,
      dimensionA: evaluation.dimension_a,
      dimensionB: evaluation.dimension_b,
      relationNormalized,
      templateSignature,
      embedding,
      evaluation,
      driftFromSeed,
      driftFromParent
    };

    questionsWithData.push(questionData);

    // Run detectors (need at least 10 questions for all detectors)
    const detectors = runAllDetectors(questionsWithData);

    // Save evaluation
    await db.insert(questionEvaluations).values({
      questionId: question.id,
      evaluatorVersion: 'round2-v1',
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
      driftFromParent: driftFromParent ? String(driftFromParent) : null,
      relationRepeat6: detectors.relationRepeat.count,
      templateShare10: detectors.templateDominance.share ? String(detectors.templateDominance.share) : null,
      dimensionEntropy10: detectors.dimensionEntropy.entropy ? String(detectors.dimensionEntropy.entropy) : null
    }).onConflictDoUpdate({
      target: [questionEvaluations.questionId, questionEvaluations.evaluatorVersion],
      set: {
        relationRepeat6: detectors.relationRepeat.count,
        templateShare10: detectors.templateDominance.share ? String(detectors.templateDominance.share) : null,
        dimensionEntropy10: detectors.dimensionEntropy.entropy ? String(detectors.dimensionEntropy.entropy) : null
      }
    });

    console.log(`  ✓ Drift: seed=${driftFromSeed?.toFixed(4) ?? 'N/A'}, parent=${driftFromParent?.toFixed(4) ?? 'N/A'}`);
    console.log(`  ✓ Template: ${evaluation.dimension_a} ${relationNormalized} ${evaluation.dimension_b} (sig: ${templateSignature})`);

    if (detectors.anyDetected && deathGen === null) {
      console.log(`  ⚠️  Detectors triggered:`);
      if (detectors.relationRepeat.detected) {
        console.log(`      - Relation repeat: "${detectors.relationRepeat.relation}" × ${detectors.relationRepeat.count}/6`);
      }
      if (detectors.templateDominance.detected) {
        console.log(`      - Template dominance: ${(detectors.templateDominance.share! * 100).toFixed(0)}% "${detectors.templateDominance.pattern}"`);
      }
      if (detectors.dimensionEntropy.detected) {
        console.log(`      - Dimension entropy: ${detectors.dimensionEntropy.entropy.toFixed(3)} bits (dominant: ${detectors.dimensionEntropy.dominantDimension})`);
      }
    }

    // Check for death (first detection wins)
    if (deathGen === null && detectors.anyDetected) {
      // Death is at the START of the failing window
      // For 6-window detectors, that's gen_index - 5
      // For 10-window detectors, that's gen_index - 9
      if (detectors.relationRepeat.detected) {
        deathGen = Math.max(0, question.genIndex - 5);
        deathCause = 'template_lock';
        deathEvidence = {
          trigger: 'relation_repeat',
          relation: detectors.relationRepeat.relation,
          count: detectors.relationRepeat.count,
          window: questionsWithData.slice(-6).map(q => ({
            gen: q.genIndex,
            relation: q.relationNormalized,
            template: `${q.dimensionA} ${q.relationNormalized} ${q.dimensionB}`
          }))
        };
      } else if (detectors.templateDominance.detected) {
        deathGen = Math.max(0, question.genIndex - 9);
        deathCause = 'template_lock';
        deathEvidence = {
          trigger: 'template_dominance',
          signature: detectors.templateDominance.signature,
          pattern: detectors.templateDominance.pattern,
          share: detectors.templateDominance.share,
          window: questionsWithData.slice(-10).map(q => ({
            gen: q.genIndex,
            signature: q.templateSignature,
            template: `${q.dimensionA} ${q.relationNormalized} ${q.dimensionB}`
          }))
        };
      } else if (detectors.dimensionEntropy.detected) {
        deathGen = Math.max(0, question.genIndex - 9);
        deathCause = 'dimension_collapse';
        deathEvidence = {
          trigger: 'dimension_entropy',
          entropy: detectors.dimensionEntropy.entropy,
          dominant: detectors.dimensionEntropy.dominantDimension,
          window: questionsWithData.slice(-10).map(q => ({
            gen: q.genIndex,
            dimA: q.dimensionA,
            dimB: q.dimensionB
          }))
        };
      }

      if (deathGen !== null) {
        console.log(`\n💀 DEATH DETECTED at gen ${deathGen}!`);
        console.log(`   Cause: ${deathCause}`);
        console.log(`   Evidence: ${JSON.stringify(deathEvidence, null, 2)}\n`);
        // Continue processing to see full pattern
      }
    }

    // Also check for structure_lost
    if (evaluation.parse_failed && deathGen === null) {
      if (question.genIndex > 0 && questionsWithData[questionsWithData.length - 2]?.evaluation?.parse_failed) {
        deathGen = question.genIndex - 1;
        deathCause = 'structure_lost';
        deathEvidence = { consecutive_parse_failures: 2 };
        console.log(`\n💀 STRUCTURE LOST at gen ${deathGen}!\n`);
      }
    }
  }

  // Record death event
  if (deathGen !== null && deathCause) {
    const deadQuestion = questionsWithData[deathGen];

    await db.insert(deathEvents).values({
      runId,
      questionId: deadQuestion.id,
      genIndex: deathGen,
      cause: deathCause as any,
      evaluatorVersion: 'round2-v1',
      evidence: deathEvidence
    }).onConflictDoUpdate({
      target: [deathEvents.runId],
      set: {
        questionId: deadQuestion.id,
        genIndex: deathGen,
        cause: deathCause as any,
        evaluatorVersion: 'round2-v1',
        evidence: deathEvidence
      }
    });

    await db.update(runs).set({
      status: 'dead',
      deathGeneration: deathGen,
      censored: false
    }).where(eq(runs.id, runId));

    console.log(`\n🎯 Death recorded at generation ${deathGen}`);
  } else {
    console.log('\n✅ No death detected - chain survived!');

    await db.update(runs).set({
      status: 'survived',
      censored: true
    }).where(eq(runs.id, runId));
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('\n📈 ROUND 2 EVALUATION SUMMARY\n');
  console.log(`Run ID: ${runId}`);
  console.log(`Status: ${deathGen ? 'DEAD' : 'SURVIVED'}`);
  if (deathGen !== null) {
    console.log(`Death generation: ${deathGen}`);
    console.log(`Death cause: ${deathCause}`);
  }
  console.log(`Total generations: ${questionsWithData.length - 1}`);

  if (unknownRelations.size > 0) {
    console.log(`\n⚠️  Unknown relations found (${unknownRelations.size}):`);
    for (const rel of unknownRelations) {
      console.log(`   - ${rel}`);
    }
    console.log('\nConsider adding these to relation-normalizer.ts');
  }

  console.log('\n' + '='.repeat(60) + '\n');

  process.exit(0);
}

async function main() {
  const [latestRun] = await db.select().from(runs).orderBy(desc(runs.createdAt)).limit(1);

  if (!latestRun) {
    console.error('No runs found!');
    process.exit(1);
  }

  await evaluateRound2(latestRun.id);
}

main().catch(err => {
  console.error('Evaluation failed:', err);
  process.exit(1);
});
