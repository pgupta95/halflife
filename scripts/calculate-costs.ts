#!/usr/bin/env tsx
/**
 * Calculate total costs for the run
 */

import { db } from './packages/db/src/client.js';
import { questions, runs } from './packages/db/src/schema.js';
import { eq, desc, sql } from 'drizzle-orm';

async function calculateCosts() {
  const [latestRun] = await db.select().from(runs).orderBy(desc(runs.createdAt)).limit(1);

  if (!latestRun) {
    console.error('No runs found!');
    process.exit(1);
  }

  console.log(`📊 Cost Analysis for Run: ${latestRun.id}\n`);
  console.log(`Model: ${latestRun.modelId}`);
  console.log(`Status: ${latestRun.status}`);
  console.log(`Death Generation: ${latestRun.deathGeneration ?? 'N/A'}\n`);

  // Get token stats from questions
  const tokenStats = await db
    .select({
      totalPromptTokens: sql<number>`SUM(COALESCE(prompt_tokens, 0))::int`,
      totalCompletionTokens: sql<number>`SUM(COALESCE(completion_tokens, 0))::int`,
      totalCostUsd: sql<string>`SUM(COALESCE(cost_usd::numeric, 0))`,
      questionCount: sql<number>`COUNT(*)::int`
    })
    .from(questions)
    .where(eq(questions.runId, latestRun.id));

  const stats = tokenStats[0];

  console.log('='.repeat(60));
  console.log('GENERATION COSTS (Gemini 2.5 Flash)');
  console.log('='.repeat(60));
  console.log(`Questions generated: ${stats.questionCount}`);
  console.log(`Prompt tokens: ${stats.totalPromptTokens.toLocaleString()}`);
  console.log(`Completion tokens: ${stats.totalCompletionTokens.toLocaleString()}`);
  console.log(`Total tokens: ${(stats.totalPromptTokens + stats.totalCompletionTokens).toLocaleString()}`);
  console.log(`Generation cost: $${parseFloat(stats.totalCostUsd).toFixed(4)}`);

  // Calculate embedding costs
  // text-embedding-004: $0.00001 per 1k characters (estimate ~200 chars per question)
  const avgCharsPerQuestion = 100; // Conservative estimate
  const totalEmbeddingChars = stats.questionCount * avgCharsPerQuestion;
  const embeddingCostPer1kChars = 0.00001;
  const embeddingCost = (totalEmbeddingChars / 1000) * embeddingCostPer1kChars;

  console.log('\n' + '='.repeat(60));
  console.log('EVALUATION COSTS');
  console.log('='.repeat(60));
  console.log(`Embeddings generated: ${stats.questionCount}`);
  console.log(`Est. characters: ${totalEmbeddingChars.toLocaleString()}`);
  console.log(`Embedding cost (text-embedding-004): $${embeddingCost.toFixed(6)}`);

  // Structure extraction: we called the LLM once per question during evaluation
  // Gemini 2.5 Flash rates: $0.075/1M input, $0.30/1M output
  const extractPromptTokensEst = 150; // Conservative estimate per extraction
  const extractOutputTokensEst = 100; // JSON schema output
  const totalExtractInputTokens = stats.questionCount * extractPromptTokensEst;
  const totalExtractOutputTokens = stats.questionCount * extractOutputTokensEst;

  const extractInputCost = (totalExtractInputTokens / 1_000_000) * 0.075;
  const extractOutputCost = (totalExtractOutputTokens / 1_000_000) * 0.30;
  const extractTotalCost = extractInputCost + extractOutputCost;

  console.log(`\nStructure extractions: ${stats.questionCount}`);
  console.log(`Est. input tokens: ${totalExtractInputTokens.toLocaleString()}`);
  console.log(`Est. output tokens: ${totalExtractOutputTokens.toLocaleString()}`);
  console.log(`Extraction cost: $${extractTotalCost.toFixed(6)}`);

  const totalEvaluationCost = embeddingCost + extractTotalCost;
  console.log(`\nTotal evaluation cost: $${totalEvaluationCost.toFixed(6)}`);

  console.log('\n' + '='.repeat(60));
  console.log('TOTAL COST');
  console.log('='.repeat(60));
  const grandTotal = parseFloat(stats.totalCostUsd) + totalEvaluationCost;
  console.log(`Generation: $${parseFloat(stats.totalCostUsd).toFixed(6)}`);
  console.log(`Evaluation: $${totalEvaluationCost.toFixed(6)}`);
  console.log(`GRAND TOTAL: $${grandTotal.toFixed(6)}`);
  console.log('='.repeat(60));

  console.log('\n💡 Cost Breakdown:');
  console.log(`  - Per question generated: $${(parseFloat(stats.totalCostUsd) / stats.questionCount).toFixed(6)}`);
  console.log(`  - Per question evaluated: $${(totalEvaluationCost / stats.questionCount).toFixed(6)}`);
  console.log(`  - Per question (total): $${(grandTotal / stats.questionCount).toFixed(6)}`);

  process.exit(0);
}

calculateCosts().catch(err => {
  console.error('Cost calculation failed:', err);
  process.exit(1);
});
