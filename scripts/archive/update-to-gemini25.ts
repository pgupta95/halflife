import { db } from './packages/db/src/client.js';
import { models } from './packages/db/src/schema.js';
import { eq } from 'drizzle-orm';

async function updateModel() {
  const existing = await db.select().from(models).where(eq(models.modelKey, 'gemini-3.7-flash'));

  if (existing.length > 0) {
    await db.update(models).set({
      modelKey: 'gemini-2.5-flash',
      displayName: 'Gemini 2.5 Flash',
      inputCostPerMtok: '0.075',
      outputCostPerMtok: '0.30',
      metadata: {
        maxConcurrency: 10,
        vertexModel: 'gemini-2.5-flash',
        supportsStructuredOutput: true,
        generation: 2.5
      }
    }).where(eq(models.modelKey, 'gemini-3.7-flash'));
  } else {
    await db.insert(models).values({
    provider: 'google',
    modelKey: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    pinnedVersion: null,
    inputCostPerMtok: '0.075',
    outputCostPerMtok: '0.30',
      metadata: {
        maxConcurrency: 10,
        vertexModel: 'gemini-2.5-flash',
        supportsStructuredOutput: true,
        generation: 2.5
      }
    });
  }

  console.log('✅ Updated to Gemini 2.5 Flash');
  process.exit(0);
}

updateModel();
