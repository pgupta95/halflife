#!/usr/bin/env tsx
/**
 * Analyze existing evaluations for attractor states
 * Reads drift data from database instead of re-calling LLM
 */

import { db } from './packages/db/src/client.js';
import { questions, questionEvaluations, deathEvents, runs } from './packages/db/src/schema.js';
import { eq, desc, asc } from 'drizzle-orm';

interface QuestionWithEval {
  genIndex: number;
  questionText: string;
  id: string;
  driftFromSeed: number | null;
  driftFromParent: number | null;
}

function calculateStats(values: number[]): { mean: number; stdDev: number } {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  return { mean, stdDev };
}

async function analyzeFromDb(runId: string) {
  console.log('🔍 Analyzing existing drift data for attractor states...\n');
  console.log(`Run ID: ${runId}\n`);

  // Get all questions with their evaluations
  const questionsWithEvals = await db
    .select({
      genIndex: questions.genIndex,
      questionText: questions.questionText,
      id: questions.id,
      driftFromSeed: questionEvaluations.driftFromSeed,
      driftFromParent: questionEvaluations.driftFromParent
    })
    .from(questions)
    .leftJoin(questionEvaluations, eq(questions.id, questionEvaluations.questionId))
    .where(eq(questions.runId, runId))
    .orderBy(asc(questions.genIndex));

  console.log(`Found ${questionsWithEvals.length} questions with evaluations\n`);

  const questionsData: QuestionWithEval[] = questionsWithEvals.map(q => ({
    genIndex: q.genIndex,
    questionText: q.questionText,
    id: q.id,
    driftFromSeed: q.driftFromSeed ? parseFloat(q.driftFromSeed) : null,
    driftFromParent: q.driftFromParent ? parseFloat(q.driftFromParent) : null
  }));

  let deathGen: number | null = null;
  let deathCause: string | null = null;

  // Scan for attractor state
  for (let i = 8; i < questionsData.length; i++) {
    const window = questionsData.slice(i - 7, i + 1); // 8 consecutive
    const driftValues = window.map(q => q.driftFromParent).filter((d): d is number => d !== null);

    if (driftValues.length === 8) {
      const stats = calculateStats(driftValues);

      console.log(`Gen ${window[0].genIndex}-${window[7].genIndex}: mean=${stats.mean.toFixed(4)}, stdDev=${stats.stdDev.toFixed(4)}`);

      if (stats.mean < 0.45 && stats.stdDev < 0.10) {
        deathGen = window[0].genIndex;
        deathCause = 'attractor_state';
        console.log(`\n💀 ATTRACTOR STATE DETECTED at gen ${deathGen}!`);
        console.log(`   Gens ${window[0].genIndex}-${window[7].genIndex}:`);
        console.log(`   Mean drift: ${stats.mean.toFixed(4)}, StdDev: ${stats.stdDev.toFixed(4)}`);
        console.log(`\n   Questions in attractor window:`);
        for (const q of window) {
          console.log(`   Gen ${q.genIndex} (drift: ${q.driftFromParent?.toFixed(4)}): ${q.questionText}`);
        }
        break;
      }
    }
  }

  if (deathGen !== null && deathCause) {
    const deadQuestion = questionsData[deathGen];
    const windowStart = deathGen;
    const windowEnd = Math.min(questionsData.length, deathGen + 8);
    const evidenceWindow = questionsData.slice(windowStart, windowEnd);

    // Check if death event already exists for this run
    const existingDeath = await db.select().from(deathEvents).where(eq(deathEvents.runId, runId));

    if (existingDeath.length > 0) {
      // Update existing death event
      await db.update(deathEvents).set({
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
          attractorStats: {
            window: evidenceWindow.map(q => q.questionText),
            mean: calculateStats(evidenceWindow.map(q => q.driftFromParent).filter((d): d is number => d !== null)).mean,
            stdDev: calculateStats(evidenceWindow.map(q => q.driftFromParent).filter((d): d is number => d !== null)).stdDev
          }
        }
      }).where(eq(deathEvents.runId, runId));
    } else {
      // Record new death event
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
          attractorStats: {
            window: evidenceWindow.map(q => q.questionText),
            mean: calculateStats(evidenceWindow.map(q => q.driftFromParent).filter((d): d is number => d !== null)).mean,
            stdDev: calculateStats(evidenceWindow.map(q => q.driftFromParent).filter((d): d is number => d !== null)).stdDev
          }
        }
      });
    }

    // Update run
    await db.update(runs)
      .set({
        status: 'dead',
        deathGeneration: deathGen,
        censored: false
      })
      .where(eq(runs.id, runId));

    console.log(`\n🎯 Death recorded at generation ${deathGen}`);
    console.log('\n' + '='.repeat(60));
    console.log(`\n💀 DEATH SUMMARY`);
    console.log(`Cause: ${deathCause}`);
    console.log(`Death generation: ${deathGen}`);
    console.log(`Total generations: ${questionsData.length - 1}`);
    console.log(`\nDead question (gen ${deathGen}):`);
    console.log(`  "${deadQuestion.questionText}"`);
    console.log('\n' + '='.repeat(60) + '\n');
  } else {
    console.log('\n✅ No attractor state detected - chain survived!');
  }

  process.exit(0);
}

async function main() {
  const [latestRun] = await db.select().from(runs).orderBy(desc(runs.createdAt)).limit(1);

  if (!latestRun) {
    console.error('No runs found!');
    process.exit(1);
  }

  await analyzeFromDb(latestRun.id);
}

main().catch(err => {
  console.error('Analysis failed:', err);
  process.exit(1);
});
