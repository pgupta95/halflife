import { db } from './packages/db/src/client.js';
import { models } from './packages/db/src/schema.js';
import { eq } from 'drizzle-orm';

async function updateModel() {
  await db.update(models)
    .set({
      modelKey: 'gemini-1.5-flash',
      displayName: 'Gemini 1.5 Flash',
      metadata: {
        maxConcurrency: 10,
        vertexModel: 'gemini-1.5-flash-002',
        supportsStructuredOutput: true
      }
    })
    .where(eq(models.modelKey, 'gemini-2.0-flash-exp'));

  console.log('Updated model to gemini-1.5-flash');
  process.exit(0);
}

updateModel();
