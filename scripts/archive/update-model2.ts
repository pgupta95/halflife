import { db } from './packages/db/src/client.js';
import { models } from './packages/db/src/schema.js';
import { eq } from 'drizzle-orm';

async function updateModel() {
  await db.update(models)
    .set({
      metadata: {
        maxConcurrency: 10,
        vertexModel: 'gemini-1.5-flash',
        supportsStructuredOutput: true
      }
    })
    .where(eq(models.modelKey, 'gemini-1.5-flash'));

  console.log('Updated model vertex name to gemini-1.5-flash');
  process.exit(0);
}

updateModel();
