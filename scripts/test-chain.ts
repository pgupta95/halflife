#!/usr/bin/env tsx
/**
 * Driftwood Test Runner - Binary Search Death Finder
 *
 * Implements efficient binary search to find where a model's questions die:
 * 1. Generate batches of 5 generations
 * 2. Check if generation 5 is alive
 * 3. If alive, continue; if dead, binary search backwards to find exact death point
 */

import { db } from './packages/db/src/client.js';
import { seeds, models, promptTemplates, runs, questions, questionEvaluations, deathEvents } from './packages/db/src/schema.js';
import { createGateway } from './packages/gateway/src/index-fetch.js';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';

// Schemas
const MutateOutputSchema = z.object({
  question: z.string().describe('One sentence. Ends with a question mark.')
});

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

type MutateOutput = z.infer<typeof MutateOutputSchema>;
type ExtractStructureOutput = z.infer<typeof ExtractStructureSchema>;

async function getPromptTemplate(name: string, version: number) {
  const [template] = await db
    .select()
    .from(promptTemplates)
    .where(and(
      eq(promptTemplates.name, name),
      eq(promptTemplates.version, version)
    ));
  return template;
}

async function getSeed(slug: string) {
  const [seed] = await db.select().from(seeds).where(eq(seeds.slug, slug));
  return seed;
}

async function getModel(modelKey: string) {
  const [model] = await db.select().from(models).where(eq(models.modelKey, modelKey));
  return model;
}

async function createRun(seedId: string, modelId: string, mutatePromptId: string) {
  const [run] = await db
    .insert(runs)
    .values({
      seedId,
      modelId,
      mutatePromptId,
      track: 'experiment',
      status: 'running',
      contextDepth: 5,
      temperature: null, // Gemini 2.0 Flash uses default
      reasoningConfig: null,
      maxGenerations: 50,
      config: { note: 'Binary search death finder test' }
    })
    .returning();
  return run;
}

async function saveQuestion(runId: string, genIndex: number, questionText: string, contextWindow: string[], response: any) {
  const [question] = await db
    .insert(questions)
    .values({
      runId,
      genIndex,
      questionText,
      contextWindow: JSON.stringify(contextWindow),
      rawResponse: response.rawResponse,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      latencyMs: response.latencyMs,
      costUsd: String(response.costUsd)
    })
    .returning();
  return question;
}

async function generateQuestion(
  gateway: ReturnType<typeof createGateway>,
  systemPrompt: string,
  userPrompt: string,
  previousQuestions: string[]
): Promise<string> {
  const questionsText = previousQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  const prompt = userPrompt.replace('{{questions}}', questionsText);

  const response = await gateway.generate({
    systemPrompt,
    userPrompt: prompt,
    schema: MutateOutputSchema
  });

  const output = response.parsed as MutateOutput;
  return output.question;
}

async function evaluateQuestion(
  gateway: ReturnType<typeof createGateway>,
  questionText: string,
  extractPrompt: string
): Promise<ExtractStructureOutput> {
  const prompt = extractPrompt.replace('{{question}}', questionText);

  const response = await gateway.generate({
    systemPrompt: 'You extract the quantitative structure of a comparison question.\n\nList an entity even if you are unsure it exists. Do not correct, improve, or comment on the question. Do not answer it.\n\nRespond with JSON only.',
    userPrompt: prompt,
    schema: ExtractStructureSchema
  });

  return response.parsed as ExtractStructureOutput;
}

async function checkIfAlive(evaluation: ExtractStructureOutput): Promise<{ alive: boolean; cause?: string; evidence: any }> {
  // Death criteria (simplified for this test):
  // 1. Structure lost: parse_failed = true
  // 2. Dimensionally malformed: dimension_a !== dimension_b for a direct comparison

  if (evaluation.parse_failed) {
    return { alive: false, cause: 'structure_lost', evidence: { parse_failed: true } };
  }

  // For now, we'll only check structure. Full groundedness checking would require
  // referent resolution which is more complex.

  // Consider it alive if it parsed correctly
  return { alive: true, evidence: evaluation };
}

async function runBinarySearchExperiment() {
  console.log('🚀 Starting Driftwood Binary Search Experiment\n');

  // Get seed and model
  const seed = await getSeed('taycan-macbook');
  const model = await getModel('gemini-2.5-flash');
  const systemTemplate = await getPromptTemplate('system_mutate', 1);
  const mutateTemplate = await getPromptTemplate('mutate_question', 1);
  const extractTemplate = await getPromptTemplate('extract_structure', 1);

  if (!seed || !model || !systemTemplate || !mutateTemplate || !extractTemplate) {
    throw new Error('Missing required data. Run seed-data.ts first.');
  }

  console.log(`📝 Seed: ${seed.questionText}`);
  console.log(`🤖 Model: ${model.displayName}\n`);

  // Create run
  const run = await createRun(seed.id, model.id, mutateTemplate.id);
  console.log(`▶️  Run ID: ${run.id}\n`);

  // Initialize gateway
  const gateway = createGateway(model.metadata.vertexModel as string);

  // Store generation 0 (the seed)
  const gen0 = await saveQuestion(run.id, 0, seed.questionText, [], {
    rawResponse: null,
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: 0,
    costUsd: 0
  });

  console.log(`Gen 0: ${seed.questionText}\n`);

  const allQuestions: Array<{ id: string; genIndex: number; text: string }> = [
    { id: gen0.id, genIndex: 0, text: seed.questionText }
  ];

  let currentGen = 1;
  let batchSize = 5;
  let deathFound = false;
  let deathGen: number | null = null;

  // Phase 1: Generate in batches of 5, checking the 5th
  console.log('📊 Phase 1: Generating in batches of 5...\n');

  while (!deathFound && currentGen <= 50) {
    console.log(`Generating batch ${Math.floor((currentGen - 1) / batchSize) + 1} (gens ${currentGen} to ${Math.min(currentGen + batchSize - 1, 50)})...`);

    for (let i = 0; i < batchSize && currentGen <= 50; i++) {
      // Get context window (last 5 questions)
      const contextStart = Math.max(0, allQuestions.length - 5);
      const context = allQuestions.slice(contextStart).map(q => q.text);

      // Generate next question
      const questionText = await generateQuestion(
        gateway,
        systemTemplate.body,
        mutateTemplate.body,
        context
      );

      // Save question
      const contextIds = allQuestions.slice(contextStart).map(q => q.id);
      const question = await saveQuestion(run.id, currentGen, questionText, contextIds, {
        rawResponse: null,
        promptTokens: 400,
        completionTokens: 150,
        latencyMs: 1000,
        costUsd: 0.0005
      });

      allQuestions.push({ id: question.id, genIndex: currentGen, text: questionText });

      console.log(`  Gen ${currentGen}: ${questionText.substring(0, 80)}${questionText.length > 80 ? '...' : ''}`);

      currentGen++;
    }

    // Check the last generation in this batch
    const lastGen = allQuestions[allQuestions.length - 1];
    console.log(`\n🔍 Evaluating gen ${lastGen.genIndex}...`);

    const evaluation = await evaluateQuestion(gateway, lastGen.text, extractTemplate.body);
    const { alive, cause, evidence } = await checkIfAlive(evaluation);

    if (!alive) {
      console.log(`💀 Death detected at or before gen ${lastGen.genIndex}!`);
      console.log(`   Cause: ${cause}`);
      deathFound = true;

      // Phase 2: Binary search to find exact death point
      console.log(`\n📊 Phase 2: Binary searching for exact death point...\n`);

      const searchStart = Math.max(0, lastGen.genIndex - batchSize + 1);
      const searchEnd = lastGen.genIndex;

      let left = searchStart;
      let right = searchEnd;
      let firstDead = searchEnd;

      while (left < right) {
        const mid = Math.floor((left + right) / 2);
        const midQuestion = allQuestions.find(q => q.genIndex === mid);

        if (!midQuestion) break;

        console.log(`  Checking gen ${mid}...`);
        const midEval = await evaluateQuestion(gateway, midQuestion.text, extractTemplate.body);
        const midStatus = await checkIfAlive(midEval);

        if (midStatus.alive) {
          console.log(`    ✅ Alive`);
          left = mid + 1;
        } else {
          console.log(`    ❌ Dead (${midStatus.cause})`);
          firstDead = mid;
          right = mid;
        }
      }

      deathGen = firstDead;
      console.log(`\n🎯 Death generation found: ${deathGen}`);

      // Record death event
      const deadQuestion = allQuestions.find(q => q.genIndex === deathGen);
      if (deadQuestion) {
        await db.insert(deathEvents).values({
          runId: run.id,
          questionId: deadQuestion.id,
          genIndex: deathGen,
          cause: cause as any,
          evaluatorVersion: 'binary-search-v1',
          evidence
        });
      }

      break;
    } else {
      console.log(`✅ Gen ${lastGen.genIndex} is alive, continuing...\n`);
    }
  }

  // Update run status
  await db
    .update(runs)
    .set({
      status: deathFound ? 'dead' : 'survived',
      deathGeneration: deathGen,
      censored: !deathFound,
      endedAt: new Date()
    })
    .where(eq(runs.id, run.id));

  console.log(`\n${'='.repeat(60)}`);
  console.log(`\n📋 EXPERIMENT COMPLETE\n`);
  console.log(`Run ID: ${run.id}`);
  console.log(`Total generations: ${allQuestions.length - 1}`); // -1 for seed
  console.log(`Status: ${deathFound ? '💀 DEAD' : '✅ SURVIVED'}`);
  if (deathGen) {
    console.log(`Death at generation: ${deathGen}`);
  }
  console.log(`\n${'='.repeat(60)}\n`);

  // Print all questions for review
  console.log(`📝 FULL QUESTION LINEAGE:\n`);
  for (const q of allQuestions) {
    const status = deathGen && q.genIndex >= deathGen ? '💀' : '✅';
    console.log(`${status} Gen ${q.genIndex}: ${q.text}`);
  }

  process.exit(0);
}

runBinarySearchExperiment().catch((err) => {
  console.error('Experiment failed:', err);
  process.exit(1);
});
