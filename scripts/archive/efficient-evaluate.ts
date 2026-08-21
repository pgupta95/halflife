#!/usr/bin/env tsx
/**
 * Efficient evaluator - only evaluates questions we need to check
 * Uses binary search to find death point
 */

import { db } from './packages/db/src/client.js';
import { questions, questionEvaluations, deathEvents, runs } from './packages/db/src/schema.js';
import { createGateway } from './packages/gateway/src/index-fetch.js';
import { generateEmbedding, calculateDrift } from './packages/gateway/src/embeddings.js';
import { eq, desc } from 'drizzle-orm';
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
  embedding?: number[];
  evaluation?: ExtractStructureOutput;
  driftFromSeed?: number;
  driftFromParent?: number;
}

async function evaluateQuestion(
  gateway: ReturnType<typeof createGateway>,
  questionText: string
): Promise<ExtractStructureOutput> {
  const extractPrompt = `Extract the quantitative structure of this comparison question:

${questionText}

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

  return response.parsed as ExtractStructureOutput;
}

async function checkQuestion(
  gateway: ReturnType<typeof createGateway>,
  question: QuestionData,
  allQuestions: QuestionData[]
): Promise<{ alive: boolean; cause?: string }> {
  console.log(`  Checking gen ${question.genIndex}...`);

  // Generate embedding
  question.embedding = await generateEmbedding(question.questionText);

  // Extract structure
  question.evaluation = await evaluateQuestion(gateway, question.questionText);

  // Calculate drift
  if (question.genIndex > 0 && allQuestions[0].embedding) {
    question.driftFromSeed = calculateDrift(question.embedding, allQuestions[0].embedding);

    // Find parent
    const parent = allQuestions.find(q => q.genIndex === question.genIndex - 1);
    if (parent && parent.embedding) {
      question.driftFromParent = calculateDrift(question.embedding, parent.embedding);
    }
  }

  // Save evaluation
  await db.insert(questionEvaluations).values({
    questionId: question.id,
    evaluatorVersion: 'drift-v1',
    referentsTotal: question.evaluation.referents.length,
    referentsResolved: 0,
    fabricatedConstants: [],
    groundedness: null,
    dimensionA: question.evaluation.dimension_a,
    dimensionB: question.evaluation.dimension_b,
    comparisonValid: question.evaluation.dimension_a === question.evaluation.dimension_b,
    tripleParsed: !question.evaluation.parse_failed,
    quantityA: question.evaluation.quantity_a,
    relation: question.evaluation.relation,
    quantityB: question.evaluation.quantity_b,
    driftFromSeed: question.driftFromSeed ? String(question.driftFromSeed) : null,
    driftFromParent: question.driftFromParent ? String(question.driftFromParent) : null
  }).onConflictDoNothing();

  console.log(`    Drift from seed: ${question.driftFromSeed?.toFixed(4) ?? 'N/A'}, from parent: ${question.driftFromParent?.toFixed(4) ?? 'N/A'}`);

  // Check for death
  if (question.evaluation.parse_failed) {
    return { alive: false, cause: 'structure_lost' };
  }

  // Check for degenerate loop (need 4 consecutive low drift)
  if (question.genIndex >= 3) {
    const last4Indices = [question.genIndex - 3, question.genIndex - 2, question.genIndex - 1, question.genIndex];
    const last4 = last4Indices.map(idx => allQuestions.find(q => q.genIndex === idx)).filter(Boolean) as QuestionData[];

    if (last4.length === 4 && last4.every(q => q.driftFromParent !== undefined && q.driftFromParent < 0.02)) {
      return { alive: false, cause: 'degenerate_loop' };
    }
  }

  return { alive: true };
}

async function efficientEvaluate(runId: string) {
  console.log('🔍 Efficient evaluation with binary search...\n');
  console.log(`Run ID: ${runId}\n`);

  // Get all questions for this run
  const allQuestionsRaw = await db
    .select()
    .from(questions)
    .where(eq(questions.runId, runId))
    .orderBy(desc(questions.genIndex));

  const allQuestions: QuestionData[] = allQuestionsRaw.reverse().map(q => ({
    id: q.id,
    genIndex: q.genIndex,
    questionText: q.questionText
  }));

  console.log(`Found ${allQuestions.length} questions\n`);

  const gateway = createGateway();

  // Always evaluate gen 0 (seed) - §3.5
  console.log('Evaluating seed (gen 0)...');
  await checkQuestion(gateway, allQuestions[0], allQuestions);

  // Check the last generation
  const lastGen = allQuestions[allQuestions.length - 1];
  console.log(`\nChecking last generation (gen ${lastGen.genIndex})...`);
  const lastStatus = await checkQuestion(gateway, lastGen, allQuestions);

  if (lastStatus.alive) {
    console.log('\n✅ Last generation is alive - chain survived!');

    await db.update(runs)
      .set({
        status: 'survived',
        censored: true
      })
      .where(eq(runs.id, runId));

    console.log('\n📈 SUMMARY: Chain survived all generations');
    process.exit(0);
  }

  // Dead! Binary search to find exact death point
  console.log(`\n💀 Last generation is dead (${lastStatus.cause})!`);
  console.log('\n📊 Binary searching for exact death point...\n');

  let left = 1; // We know gen 0 is alive (it's the seed)
  let right = lastGen.genIndex;
  let firstDead = lastGen.genIndex;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    const midQuestion = allQuestions[mid];

    const midStatus = await checkQuestion(gateway, midQuestion, allQuestions);

    if (midStatus.alive) {
      console.log(`    ✅ Alive`);
      left = mid + 1;
    } else {
      console.log(`    ❌ Dead (${midStatus.cause})`);
      firstDead = mid;
      right = mid;
    }
  }

  console.log(`\n🎯 Death generation found: ${firstDead}`);
  const deadQuestion = allQuestions[firstDead];

  // For degenerate loop, we need to check if this is the first of a streak
  // Need to evaluate a few more questions around the death point
  if (lastStatus.cause === 'degenerate_loop') {
    console.log('\n📊 Verifying degenerate loop streak...\n');

    // Evaluate the 3 generations before firstDead to confirm it's the start of the streak
    const startIdx = Math.max(1, firstDead - 3);
    for (let i = startIdx; i < firstDead; i++) {
      if (!allQuestions[i].embedding) {
        await checkQuestion(gateway, allQuestions[i], allQuestions);
      }
    }

    // Evaluate a few after to confirm the streak
    for (let i = firstDead + 1; i <= Math.min(firstDead + 3, allQuestions.length - 1); i++) {
      if (!allQuestions[i].embedding) {
        await checkQuestion(gateway, allQuestions[i], allQuestions);
      }
    }

    // Find the actual start of the 4-consecutive streak
    for (let i = 4; i < allQuestions.length; i++) {
      const last4 = allQuestions.slice(i - 3, i + 1);
      const allLowDrift = last4.every(q => q.driftFromParent !== undefined && q.driftFromParent < 0.02);

      if (allLowDrift) {
        firstDead = last4[0].genIndex; // §3.3: first of the streak
        console.log(`💀 Degenerate loop starts at gen ${firstDead}`);
        console.log(`   Gens ${last4[0].genIndex}-${last4[3].genIndex} all have drift < 0.02`);
        for (const q of last4) {
          console.log(`   Gen ${q.genIndex}: drift = ${q.driftFromParent?.toFixed(4)}`);
        }
        break;
      }
    }
  }

  // Record death event
  await db.insert(deathEvents).values({
    runId,
    questionId: allQuestions[firstDead].id,
    genIndex: firstDead,
    cause: lastStatus.cause as any,
    evaluatorVersion: 'drift-v1',
    evidence: {
      driftValues: allQuestions
        .filter(q => q.driftFromParent !== undefined)
        .map(q => ({ gen: q.genIndex, driftFromParent: q.driftFromParent }))
    }
  }).onConflictDoNothing();

  // Update run
  await db.update(runs)
    .set({
      status: 'dead',
      deathGeneration: firstDead,
      censored: false
    })
    .where(eq(runs.id, runId));

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('\n📈 EVALUATION SUMMARY\n');
  console.log(`Run ID: ${runId}`);
  console.log(`Total generations: ${allQuestions.length - 1}`);
  console.log(`Death generation: ${firstDead}`);
  console.log(`Death cause: ${lastStatus.cause}`);
  console.log(`Questions evaluated: ${allQuestions.filter(q => q.embedding).length}`);
  console.log(`Questions saved: ${allQuestions.length - allQuestions.filter(q => q.embedding).length} (not evaluated)`);
  console.log('\n' + '='.repeat(60));
  console.log(`\n💀 Dead question (gen ${firstDead}):`);
  console.log(`  "${deadQuestion.questionText}"`);
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

  await efficientEvaluate(latestRun.id);
}

main().catch(err => {
  console.error('Evaluation failed:', err);
  process.exit(1);
});
