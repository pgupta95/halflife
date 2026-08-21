import { db } from './packages/db/src/client.js';
import { models } from './packages/db/src/schema.js';
import { eq } from 'drizzle-orm';

async function updateModel() {
  // Try to update existing, or insert new
  const existing = await db.select().from(models).where(eq(models.modelKey, 'gemini-1.5-flash'));

  if (existing.length > 0) {
    await db.update(models)
      .set({
        modelKey: 'gemini-3.0-flash',
        displayName: 'Gemini 3.0 Flash',
        inputCostPerMtok: '0.10',
        outputCostPerMtok: '0.40',
        metadata: {
          maxConcurrency: 10,
          vertexModel: 'gemini-3.0-flash',
          supportsStructuredOutput: true,
          generation: 3
        }
      })
      .where(eq(models.modelKey, 'gemini-1.5-flash'));
    console.log('✅ Updated to Gemini 3.0 Flash');
  } else {
    await db.insert(models).values({
      provider: 'google',
      modelKey: 'gemini-3.0-flash',
      displayName: 'Gemini 3.0 Flash',
      inputCostPerMtok: '0.10',
      outputCostPerMtok: '0.40',
      metadata: {
        maxConcurrency: 10,
        vertexModel: 'gemini-3.0-flash',
        supportsStructuredOutput: true,
        generation: 3
      }
    });
    console.log('✅ Inserted Gemini 3.0 Flash');
  }

  process.exit(0);
}

updateModel();
