import { db } from './packages/db/src/client.js';
import { models } from './packages/db/src/schema.js';
import { eq } from 'drizzle-orm';

async function updateModel() {
  // Update or insert Gemini 3.7 Flash
  const existing = await db.select().from(models).where(eq(models.modelKey, 'gemini-3.0-flash'));

  if (existing.length > 0) {
    await db.update(models)
      .set({
        modelKey: 'gemini-3.7-flash',
        displayName: 'Gemini 3.7 Flash',
        pinnedVersion: null,
        inputCostPerMtok: '0.10', // Assuming similar to 3.0 pricing
        outputCostPerMtok: '0.40',
        metadata: {
          maxConcurrency: 10,
          vertexModel: 'gemini-3.7-flash',
          supportsStructuredOutput: true,
          generation: 3.7,
          contextWindow: 1000000,
          maxOutputTokens: 64000
        }
      })
      .where(eq(models.modelKey, 'gemini-3.0-flash'));
    console.log('✅ Updated to Gemini 3.7 Flash');
  } else {
    await db.insert(models).values({
      provider: 'google',
      modelKey: 'gemini-3.7-flash',
      displayName: 'Gemini 3.7 Flash',
      pinnedVersion: null,
      inputCostPerMtok: '0.10',
      outputCostPerMtok: '0.40',
      metadata: {
        maxConcurrency: 10,
        vertexModel: 'gemini-3.7-flash',
        supportsStructuredOutput: true,
        generation: 3.7,
        contextWindow: 1000000,
        maxOutputTokens: 64000
      }
    });
    console.log('✅ Inserted Gemini 3.7 Flash');
  }

  process.exit(0);
}

updateModel();
